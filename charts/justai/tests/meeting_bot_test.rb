# Run with: ruby charts/justai/tests/meeting_bot_test.rb
require 'minitest/autorun'
require 'open3'
require 'tmpdir'
require 'yaml'
require 'json'

class MeetingBotChartTest < Minitest::Test
  CHART = File.expand_path('..', __dir__)
  TOKEN = 'test-only-token-with-more-than-32-characters'

  def render(values = {}, error: nil)
    Dir.mktmpdir('justai-chart-test') do |dir|
      path = File.join(dir, 'values.yaml')
      File.write(path, values.to_json)
      out, err, status = Open3.capture3({ 'HELM_PLUGINS' => File.join(dir, 'plugins') },
                                        'helm', 'template', 'bot-test', CHART, '-f', path)
      if error
        refute status.success?, 'invalid meeting bot configuration rendered successfully'
        assert_includes err, error
        return
      end
      assert status.success?, err
      YAML.load_stream(out).compact
    end
  end

  def enabled(extra = {})
    base = {
      'meetingBot' => { 'enabled' => true },
      'secrets' => { 'refs' => { 'meetingBotToken' => { 'name' => 'bot-credentials' } } }
    }
    base.merge(extra) { |_key, old, new| old.merge(new) }
  end

  def find(docs, kind, component)
    docs.find { |d| d['kind'] == kind && d.dig('metadata', 'labels', 'app.kubernetes.io/component') == component }
  end

  def bot_spec(docs)
    find(docs, 'Deployment', 'meeting-bot').dig('spec', 'template', 'spec')
  end

  def bot_env(docs)
    bot_spec(docs)['containers'].first['env'].to_h { |e| [e['name'], e] }
  end

  def backend_env(docs, mode)
    deployment = find(docs, 'Deployment', mode == 'monolith' ? 'monolith' : 'backend')
    deployment.dig('spec', 'template', 'spec', 'containers').first['env'].to_h { |e| [e['name'], e] }
  end

  def test_disabled_by_default
    %w[microservices monolith].each do |mode|
      docs = render({ 'deploymentMode' => mode })
      %w[Deployment Service NetworkPolicy].each do |kind|
        assert_nil find(docs, kind, 'meeting-bot'), "#{kind} must not exist when the bot is disabled"
      end
      refute backend_env(docs, mode).keys.any? { |name| name.start_with?('JUSTAI_MEETING_BOT_') }
    end
  end

  def test_bot_pod_runs_one_unprivileged_replica
    docs = render(enabled)
    deployment = find(docs, 'Deployment', 'meeting-bot')
    assert_equal 1, deployment.dig('spec', 'replicas'), 'bots live in memory; a second replica would lose track of them'
    assert_equal 'Recreate', deployment.dig('spec', 'strategy', 'type')
    spec = bot_spec(docs)
    assert_equal false, spec['automountServiceAccountToken'], 'the browser must not receive API credentials'
    assert_equal false, spec['enableServiceLinks']
    assert_equal true, spec.dig('securityContext', 'runAsNonRoot')
    assert_equal 'RuntimeDefault', spec.dig('securityContext', 'seccompProfile', 'type')
    container = spec['containers'].first
    assert_equal ['serve'], container['args']
    context = container['securityContext']
    assert_equal false, context['allowPrivilegeEscalation']
    assert_equal true, context['readOnlyRootFilesystem']
    assert_equal ['ALL'], context.dig('capabilities', 'drop')
    refute context.key?('capabilities') && context['capabilities'].key?('add')
    assert container.dig('resources', 'limits', 'memory'), 'a memory limit is required'
    assert_equal [{ 'name' => 'tmp', 'mountPath' => '/tmp' }], container['volumeMounts']
    assert spec['volumes'].find { |v| v['name'] == 'tmp' }.dig('emptyDir', 'sizeLimit')
    assert_equal '/tmp', bot_env(docs)['HOME']['value']
    assert_equal '/healthz', container.dig('readinessProbe', 'httpGet', 'path')
  end

  def test_bot_and_backend_find_each_other_and_share_the_token
    { 'microservices' => 'http://bot-test-justai-backend:8080', 'monolith' => 'http://bot-test-justai:8080' }.each do |mode, backend_url|
      docs = render(enabled('deploymentMode' => mode))
      env = bot_env(docs)
      assert_equal backend_url, env['JUSTAI_URL']['value']
      assert_equal({ 'name' => 'bot-credentials', 'key' => 'meeting-bot-token' },
                   env['MEETING_BOT_SERVICE_TOKEN'].dig('valueFrom', 'secretKeyRef'))

      backend = backend_env(docs, mode)
      assert_equal 'http://bot-test-justai-meeting-bot:8091', backend['JUSTAI_MEETING_BOT_URL']['value']
      assert_equal({ 'name' => 'bot-credentials', 'key' => 'meeting-bot-token' },
                   backend['JUSTAI_MEETING_BOT_TOKEN'].dig('valueFrom', 'secretKeyRef'))
      refute backend['JUSTAI_MEETING_BOT_TOKEN'].key?('value'), 'the token must never be an inline value'
    end
  end

  def test_bot_settings_reach_the_container
    docs = render(enabled('meetingBot' => { 'maxBots' => 4, 'botName' => 'Protokoll-Bot', 'silenceMinutes' => 15 }))
    env = bot_env(docs).transform_values { |e| e['value'] }
    assert_equal 'card', env['BOT_CAMERA'], 'by default the bot shows who is listening'
    render(enabled('meetingBot' => { 'camera' => 'webcam' }), error: 'meetingBot.camera')
    assert_equal '4', env['MEETING_BOT_MAX_BOTS']
    assert_equal 'Protokoll-Bot', env['BOT_NAME']
    assert_equal '15', env['BOT_SILENCE_MINUTES']
  end

  def test_network_policy_admits_only_the_backend_and_blocks_private_ranges
    %w[microservices monolith].each do |mode|
      spec = find(render(enabled('deploymentMode' => mode)), 'NetworkPolicy', 'meeting-bot')['spec']
      assert_equal %w[Ingress Egress], spec['policyTypes']
      assert_equal 1, spec['ingress'].length
      from = spec['ingress'].first['from'].first['podSelector']
      assert_equal %w[backend monolith], from['matchExpressions'].first['values']
      assert_equal [{ 'protocol' => 'TCP', 'port' => 8091 }], spec['ingress'].first['ports']

      backend_rule = spec['egress'].find { |rule| rule['to']&.first&.key?('podSelector') }
      assert_equal [{ 'protocol' => 'TCP', 'port' => 8080 }], backend_rule['ports']
      internet = spec['egress'].find { |rule| rule['to']&.first&.key?('ipBlock') }['to']
      v4 = internet.find { |block| block.dig('ipBlock', 'cidr') == '0.0.0.0/0' }['ipBlock']
      %w[10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16].each do |cidr|
        assert_includes v4['except'], cidr, "#{cidr} must stay unreachable from meeting pages"
      end
      v6 = internet.find { |block| block.dig('ipBlock', 'cidr') == '::/0' }['ipBlock']
      assert_includes v6['except'], 'fc00::/7'
    end
  end

  def test_network_policy_takes_extra_egress_and_can_be_disabled
    extra = [{ 'to' => [{ 'ipBlock' => { 'cidr' => '10.20.0.5/32' } }], 'ports' => [{ 'protocol' => 'TCP', 'port' => 443 }] }]
    spec = find(render(enabled('meetingBot' => { 'networkPolicy' => { 'enabled' => true, 'extraEgress' => extra } })), 'NetworkPolicy', 'meeting-bot')['spec']
    assert_includes spec['egress'], extra.first
    docs = render(enabled('meetingBot' => { 'networkPolicy' => { 'enabled' => false } }))
    assert_nil find(docs, 'NetworkPolicy', 'meeting-bot')
  end

  def test_service_is_cluster_internal
    service = find(render(enabled), 'Service', 'meeting-bot')
    assert_equal 'ClusterIP', service.dig('spec', 'type')
    assert_equal 8091, service.dig('spec', 'ports', 0, 'port')
  end

  def test_image_defaults_to_the_release_tag_and_can_be_overridden
    image = ->(docs) { bot_spec(docs)['containers'].first['image'] }
    assert_match(%r{\Aghcr\.io/justlabv1/justai:meeting-bot-}, image.call(render(enabled)))
    custom = enabled('meetingBot' => { 'image' => { 'repository' => 'registry.example/bot', 'tag' => '1.2.3' } })
    assert_equal 'registry.example/bot:1.2.3', image.call(render(custom))
  end

  def test_generated_secret_contains_the_token_under_its_own_key
    docs = render({ 'meetingBot' => { 'enabled' => true },
                    'secrets' => { 'create' => true, 'data' => { 'meetingBotToken' => TOKEN, 'jwtSecret' => 'j', 'encryptionKey' => 'e' } } })
    secret = docs.find { |d| d['kind'] == 'Secret' }
    assert_equal TOKEN, secret['data']['meeting-bot-token'].unpack1('m')
  end

  def test_enabling_requires_a_long_enough_token
    render({ 'meetingBot' => { 'enabled' => true } }, error: 'meetingBot.enabled requires')
    render({ 'meetingBot' => { 'enabled' => true }, 'secrets' => { 'create' => true, 'data' => { 'meetingBotToken' => 'short' } } },
           error: 'at least 32 characters')
  end

  def test_bot_count_is_bounded
    render(enabled('meetingBot' => { 'maxBots' => 0 }), error: 'meetingBot.maxBots')
    render(enabled('meetingBot' => { 'maxBots' => 50 }), error: 'meetingBot.maxBots')
  end
end
