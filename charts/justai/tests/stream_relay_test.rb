# Run with: ruby charts/justai/tests/stream_relay_test.rb
require 'minitest/autorun'
require 'open3'
require 'tmpdir'
require 'yaml'
require 'base64'
require 'json'

class StreamRelayChartTest < Minitest::Test
  CHART = File.expand_path('..', __dir__)
  TOKEN = 'test-only-token-with-more-than-32-characters'

  def render(values = {}, error: nil, **overrides)
    values = values.merge(overrides)
    Dir.mktmpdir('justai-chart-test') do |dir|
      path = File.join(dir, 'values.yaml')
      File.write(path, values.to_json)
      out, err, status = Open3.capture3({'HELM_PLUGINS' => File.join(dir, 'plugins')},
                                      'helm', 'template', 'relay-test', CHART, '-f', path)
      if error
        refute status.success?, 'invalid relay configuration rendered successfully'
        assert_includes err, error
        return
      end
      assert status.success?, err
      YAML.load_stream(out).compact
    end
  end

  def app_containers(docs)
    docs.select { |doc| doc['kind'] == 'Deployment' }.flat_map do |doc|
      doc.dig('spec', 'template', 'spec', 'containers')
    end
  end

  def test_disabled_by_default
    docs = render
    app_containers(docs).each do |container|
      refute container.fetch('env', []).any? { |e| e['name'].start_with?('JUSTAI_STREAM_RELAY_') }
      refute container.fetch('volumeMounts', []).any? { |m| m['name'] == 'stream-relay-token' }
    end
  end

  def test_external_secret_is_file_mounted_in_both_deployment_modes
    %w[microservices monolith].each do |mode|
      docs = render('deploymentMode' => mode,
                    'backend' => {'streamRelay' => {'url' => 'https://relay.example.org'}},
                    'secrets' => {'refs' => {'streamRelayToken' => {'name' => 'relay-credentials', 'key' => 'custom-token'}}})
      app = docs.find { |d| d['kind'] == 'Deployment' && d.dig('metadata', 'labels', 'app.kubernetes.io/component') == (mode == 'monolith' ? 'monolith' : 'backend') }
      spec = app.dig('spec', 'template', 'spec')
      container = spec['containers'].first
      env = container['env'].to_h { |e| [e['name'], e['value']] }
      assert_equal 'https://relay.example.org', env['JUSTAI_STREAM_RELAY_URL']
      assert_equal '/var/run/justai/stream-relay/token', env['JUSTAI_STREAM_RELAY_TOKEN_FILE']
      mount = container['volumeMounts'].find { |m| m['name'] == 'stream-relay-token' }
      assert_equal true, mount['readOnly']
      refute mount.key?('subPath'), 'directory mount should receive Kubernetes Secret updates'
      secret = spec['volumes'].find { |v| v['name'] == 'stream-relay-token' }['secret']
      assert_equal 'relay-credentials', secret['secretName']
      assert_equal [{'key' => 'custom-token', 'path' => 'token'}], secret['items']
      refute secret['optional'], 'missing token must prevent pod startup'
      frontend = app_containers(docs).find { |c| c['name'] == 'frontend' }
      next unless frontend
      refute frontend.fetch('env', []).any? { |e| e['name'].start_with?('JUSTAI_STREAM_RELAY_') }
      refute frontend.fetch('volumeMounts', []).any? { |m| m['name'] == 'stream-relay-token' }
    end
  end

  def test_shared_and_vault_secret_fallbacks
    [{'existingSecret' => 'shared-app-secrets'},
     {'create' => true, 'vault' => {'enabled' => true, 'authRef' => 'vault', 'path' => 'justai'}}].each do |secret_values|
      docs = render('backend' => {'streamRelay' => {'url' => 'https://relay.example.org'}}, 'secrets' => secret_values)
      app = docs.find { |d| d['kind'] == 'Deployment' && d['metadata']['name'].end_with?('-backend') }
      secret = app.dig('spec', 'template', 'spec', 'volumes').find { |v| v['name'] == 'stream-relay-token' }['secret']
      assert_equal(secret_values['existingSecret'] || 'relay-test-justai-secrets', secret['secretName'])
      assert_equal 'stream-relay-token', secret['items'].first['key']
    end
  end

  def test_managed_secret_contains_token_without_exposing_it_in_deployment
    docs = render('backend' => {'streamRelay' => {'url' => 'https://relay.example.org'}},
                  'secrets' => {'create' => true, 'data' => {'streamRelayToken' => TOKEN}})
    secret = docs.find { |d| d['kind'] == 'Secret' }
    assert_equal TOKEN, Base64.decode64(secret['data']['stream-relay-token'])
    app_containers(docs).each { |c| refute_includes c.to_s, TOKEN }
  end

  def test_invalid_or_missing_credentials_fail_closed
    render({'backend' => {'streamRelay' => {'url' => 'https://relay.example.org'}}}, error: 'requires secrets.refs.streamRelayToken')
    render({'backend' => {'streamRelay' => {'url' => 'https://relay.example.org'}},
            'secrets' => {'create' => true, 'data' => {'streamRelayToken' => 'short'}}}, error: 'at least 32 characters')
    %w[http://relay.example.org https://user:pass@relay.example.org https://relay.example.org/path https://relay.example.org?token=x https://relay.example.org#fragment].each do |url|
      render({'backend' => {'streamRelay' => {'url' => url}}, 'secrets' => {'existingSecret' => 'app'}}, error: 'must be an HTTPS origin')
    end
    render({'backend' => {'streamRelay' => {'url' => 'https://relay.example.org'}},
            'secrets' => {'refs' => {'streamRelayToken' => {'name' => 'relay', 'key' => '../bad'}}}}, error: 'is invalid')
  end
  RELAYS = [
    {'name' => 'Berlin', 'url' => 'https://relay-berlin.example.org', 'tokenSecret' => {'name' => 'relay-berlin', 'key' => 'tok'}},
    {'name' => 'Bonn', 'url' => 'https://relay-bonn.example.org/', 'tokenSecret' => {'name' => 'relay-bonn'}}
  ].freeze

  def test_additional_relays_are_listed_and_mounted_per_secret
    %w[microservices monolith].each do |mode|
      docs = render('deploymentMode' => mode, 'backend' => {'streamRelays' => RELAYS})
      app = docs.find { |d| d['kind'] == 'Deployment' && d.dig('metadata', 'labels', 'app.kubernetes.io/component') == (mode == 'monolith' ? 'monolith' : 'backend') }
      spec = app.dig('spec', 'template', 'spec')
      container = spec['containers'].first
      env = container['env'].to_h { |e| [e['name'], e['value']] }
      assert_equal 'Berlin=https://relay-berlin.example.org|/var/run/justai/stream-relays/0/token,' \
                   'Bonn=https://relay-bonn.example.org|/var/run/justai/stream-relays/1/token', env['JUSTAI_STREAM_RELAYS']
      refute env.key?('JUSTAI_STREAM_RELAY_URL'), 'single relay stays disabled'
      assert_equal %w[/var/run/justai/stream-relays/0 /var/run/justai/stream-relays/1],
                   container['volumeMounts'].select { |m| m['name'].start_with?('stream-relay-') }.map { |m| m['mountPath'] }
      secrets = spec['volumes'].select { |v| v['name'].start_with?('stream-relay-') }.map { |v| v['secret'] }
      assert_equal %w[relay-berlin relay-bonn], secrets.map { |x| x['secretName'] }
      assert_equal [[{'key' => 'tok', 'path' => 'token'}], [{'key' => 'stream-relay-token', 'path' => 'token'}]], secrets.map { |x| x['items'] }
      frontend = app_containers(docs).find { |c| c['name'] == 'frontend' }
      next unless frontend
      refute frontend.fetch('env', []).any? { |e| e['name'].start_with?('JUSTAI_STREAM_RELAY') }
    end
  end

  def test_additional_relays_combine_with_the_single_relay
    docs = render('backend' => {'streamRelay' => {'url' => 'https://relay.example.org'}, 'streamRelays' => RELAYS},
                  'secrets' => {'existingSecret' => 'app'})
    app = docs.find { |d| d['kind'] == 'Deployment' && d.dig('metadata', 'labels', 'app.kubernetes.io/component') == 'backend' }
    env = app.dig('spec', 'template', 'spec', 'containers', 0, 'env').to_h { |e| [e['name'], e['value']] }
    assert_equal 'https://relay.example.org', env['JUSTAI_STREAM_RELAY_URL']
    assert env['JUSTAI_STREAM_RELAYS']
  end

  def test_invalid_additional_relays_fail_rendering
    bad = lambda { |overrides| RELAYS.first.merge(overrides) }
    render({'backend' => {'streamRelays' => [bad.call('url' => 'http://relay.example.org')]}}, error: 'must be an HTTPS origin')
    render({'backend' => {'streamRelays' => [bad.call('url' => 'https://relay.example.org/path')]}}, error: 'must be an HTTPS origin')
    render({'backend' => {'streamRelays' => [bad.call('name' => 'a,b')]}}, error: 'without = | or commas')
    render({'backend' => {'streamRelays' => [bad.call('tokenSecret' => {})]}}, error: 'tokenSecret.name')
    render({'backend' => {'streamRelays' => [bad.call('tokenSecret' => {'name' => 'x', 'key' => '../bad'})]}}, error: 'tokenSecret.key is invalid')
    render({'backend' => {'streamRelays' => Array.new(9) { |i| bad.call('url' => "https://r#{i}.example.org") }}}, error: 'at most 8')
  end
end
