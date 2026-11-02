# Run with: ruby charts/justai/tests/usage_metrics_test.rb
require 'minitest/autorun'
require 'open3'
require 'tmpdir'
require 'yaml'
require 'json'

class UsageMetricsChartTest < Minitest::Test
  CHART = File.expand_path('..', __dir__)

  def render(values = {})
    Dir.mktmpdir('justai-metrics-test') do |dir|
      path = File.join(dir, 'values.yaml')
      File.write(path, ({'secrets' => {'existingSecret' => 'app'}}.merge(values)).to_json)
      out, err, status = Open3.capture3('helm', 'template', 'metrics-test', CHART, '-f', path)
      assert status.success?, err
      YAML.load_stream(out).compact
    end
  end

  def env_names(docs)
    docs.select { |d| d['kind'] == 'Deployment' }
        .flat_map { |d| d.dig('spec', 'template', 'spec', 'containers') }
        .flat_map { |c| c.fetch('env', []).map { |e| e['name'] } }
  end

  def test_disabled_by_default
    docs = render
    refute_includes env_names(docs), 'JUSTAI_METRICS_TOKEN'
    assert_empty docs.select { |d| d['kind'] == 'ServiceMonitor' }
  end

  def test_token_comes_from_secret_in_both_modes
    %w[microservices monolith].each do |mode|
      docs = render('deploymentMode' => mode, 'metrics' => {'usage' => {'enabled' => true}},
                    'secrets' => {'refs' => {'metricsToken' => {'name' => 'metrics', 'key' => 'tok'}}})
      envs = docs.select { |d| d['kind'] == 'Deployment' }
                 .flat_map { |d| d.dig('spec', 'template', 'spec', 'containers') }
                 .flat_map { |c| c.fetch('env', []) }
                 .select { |e| e['name'] == 'JUSTAI_METRICS_TOKEN' }
      assert_equal 1, envs.size, mode
      assert_equal({'name' => 'metrics', 'key' => 'tok'}, envs.first.dig('valueFrom', 'secretKeyRef'))
    end
  end

  def test_service_monitor_scrapes_usage_endpoint
    docs = render('metrics' => {'usage' => {'enabled' => true}, 'serviceMonitor' => {'enabled' => true, 'labels' => {'release' => 'prom'}}})
    monitor = docs.find { |d| d['kind'] == 'ServiceMonitor' }
    refute_nil monitor
    assert_equal 'prom', monitor.dig('metadata', 'labels', 'release')
    endpoint = monitor.dig('spec', 'endpoints', 0)
    assert_equal '/metrics/usage', endpoint['path']
    assert_equal 'metrics-token', endpoint.dig('authorization', 'credentials', 'key')
  end

  def test_service_monitor_requires_usage_metrics
    docs = render('metrics' => {'serviceMonitor' => {'enabled' => true}})
    assert_empty docs.select { |d| d['kind'] == 'ServiceMonitor' }
  end
end
