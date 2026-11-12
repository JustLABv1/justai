# Run with: ruby charts/justai/tests/code_runner_test.rb
require 'minitest/autorun'
require 'open3'
require 'tmpdir'
require 'yaml'
require 'json'

class CodeRunnerChartTest < Minitest::Test
  CHART = File.expand_path('..', __dir__)
  TOKEN = 'test-only-token-with-more-than-32-characters'
  CAPABILITIES = %w[CHOWN DAC_OVERRIDE FOWNER SETUID SETGID KILL].freeze

  def render(values = {}, error: nil)
    Dir.mktmpdir('justai-chart-test') do |dir|
      path = File.join(dir, 'values.yaml')
      File.write(path, values.to_json)
      out, err, status = Open3.capture3({ 'HELM_PLUGINS' => File.join(dir, 'plugins') },
                                        'helm', 'template', 'runner-test', CHART, '-f', path)
      if error
        refute status.success?, 'invalid code runner configuration rendered successfully'
        assert_includes err, error
        return
      end
      assert status.success?, err
      YAML.load_stream(out).compact
    end
  end

  def enabled(extra = {})
    base = {
      'codeRunner' => { 'enabled' => true },
      'secrets' => { 'refs' => { 'codeRunnerToken' => { 'name' => 'runner-credentials' } } }
    }
    base.merge(extra) { |_key, old, new| old.merge(new) }
  end

  def find(docs, kind, component)
    docs.find { |d| d['kind'] == kind && d.dig('metadata', 'labels', 'app.kubernetes.io/component') == component }
  end

  def backend_env(docs, mode)
    deployment = find(docs, 'Deployment', mode == 'monolith' ? 'monolith' : 'backend')
    deployment.dig('spec', 'template', 'spec', 'containers').first['env'].to_h { |e| [e['name'], e] }
  end

  def test_disabled_by_default
    docs = render
    %w[Deployment Service NetworkPolicy].each do |kind|
      assert_nil find(docs, kind, 'code-runner'), "#{kind} must not exist when the runner is disabled"
    end
    %w[microservices monolith].each do |mode|
      env = backend_env(render({ 'deploymentMode' => mode }), mode)
      refute env.keys.any? { |name| name.start_with?('JUSTAI_CODE_RUNNER_') }
    end
  end

  def test_runner_pod_is_locked_down
    docs = render(enabled)
    spec = find(docs, 'Deployment', 'code-runner').dig('spec', 'template', 'spec')

    assert_equal false, spec['automountServiceAccountToken'], 'user code must not receive API credentials'
    assert_equal false, spec['enableServiceLinks']
    refute spec.key?('serviceAccountName')
    assert_equal 'RuntimeDefault', spec.dig('securityContext', 'seccompProfile', 'type')

    container = spec['containers'].first
    context = container['securityContext']
    assert_equal false, context['allowPrivilegeEscalation']
    assert_equal true, context['readOnlyRootFilesystem']
    assert_equal ['ALL'], context.dig('capabilities', 'drop')
    assert_equal CAPABILITIES.sort, context.dig('capabilities', 'add').sort
    assert container.dig('resources', 'limits', 'memory'), 'a memory limit is required'

    work = spec['volumes'].find { |v| v['name'] == 'work' }['emptyDir']
    assert work['sizeLimit'], 'the scratch volume needs a size limit'
    assert_equal [{ 'name' => 'work', 'mountPath' => '/work' }], container['volumeMounts']
    assert_equal '/healthz', container.dig('readinessProbe', 'httpGet', 'path')
  end

  def test_token_is_read_from_the_secret_by_runner_and_backend
    %w[microservices monolith].each do |mode|
      docs = render(enabled('deploymentMode' => mode))
      runner_env = find(docs, 'Deployment', 'code-runner').dig('spec', 'template', 'spec', 'containers').first['env']
      runner_token = runner_env.find { |e| e['name'] == 'CODE_RUNNER_TOKEN' }
      assert_equal({ 'name' => 'runner-credentials', 'key' => 'code-runner-token' }, runner_token.dig('valueFrom', 'secretKeyRef'))

      env = backend_env(docs, mode)
      assert_equal 'http://runner-test-justai-code-runner:8090', env['JUSTAI_CODE_RUNNER_URL']['value']
      assert_equal({ 'name' => 'runner-credentials', 'key' => 'code-runner-token' },
                   env['JUSTAI_CODE_RUNNER_TOKEN'].dig('valueFrom', 'secretKeyRef'))
      refute env['JUSTAI_CODE_RUNNER_TOKEN'].key?('value'), 'the token must never be an inline value'
    end
  end

  def test_network_policy_allows_only_the_backend_in_and_nothing_out
    policy = find(render(enabled), 'NetworkPolicy', 'code-runner')
    spec = policy['spec']
    assert_equal %w[Ingress Egress], spec['policyTypes']
    assert_equal [], spec['egress'], 'the runner must not be allowed to open connections'
    assert_equal 1, spec['ingress'].length
    selector = spec['ingress'].first['from'].first['podSelector']
    assert_equal [{ 'key' => 'app.kubernetes.io/component', 'operator' => 'In', 'values' => %w[backend monolith] }],
                 selector['matchExpressions']
    assert_equal [{ 'protocol' => 'TCP', 'port' => 8090 }], spec['ingress'].first['ports']
    assert_equal 'code-runner', spec.dig('podSelector', 'matchLabels', 'app.kubernetes.io/component')
  end

  def test_network_policy_can_be_disabled_explicitly
    docs = render(enabled('codeRunner' => { 'networkPolicy' => { 'enabled' => false } }))
    assert_nil find(docs, 'NetworkPolicy', 'code-runner')
  end

  def test_service_exposes_the_runner_inside_the_cluster_only
    service = find(render(enabled), 'Service', 'code-runner')
    assert_equal 'ClusterIP', service.dig('spec', 'type')
    assert_equal 8090, service.dig('spec', 'ports', 0, 'port')
    assert_equal 'code-runner', service.dig('spec', 'selector', 'app.kubernetes.io/component')
  end

  def test_image_defaults_to_the_release_tag_and_can_be_overridden
    image = ->(docs) { find(docs, 'Deployment', 'code-runner').dig('spec', 'template', 'spec', 'containers').first['image'] }
    assert_match(%r{\Aghcr\.io/justlabv1/justai:code-runner-}, image.call(render(enabled)))
    custom = enabled('codeRunner' => { 'image' => { 'repository' => 'registry.example/runner', 'tag' => '1.2.3' } })
    assert_equal 'registry.example/runner:1.2.3', image.call(render(custom))
  end

  def test_runtime_class_and_limits_are_configurable
    docs = render(enabled('codeRunner' => { 'runtimeClassName' => 'gvisor', 'maxConcurrent' => 4, 'memoryMb' => 1024 }))
    spec = find(docs, 'Deployment', 'code-runner').dig('spec', 'template', 'spec')
    assert_equal 'gvisor', spec['runtimeClassName']
    env = spec['containers'].first['env'].to_h { |e| [e['name'], e['value']] }
    assert_equal '4', env['CODE_RUNNER_MAX_CONCURRENT']
    assert_equal '1024', env['CODE_RUNNER_MEMORY_MB']
  end

  def test_generated_secret_contains_the_token_under_its_own_key
    docs = render({ 'codeRunner' => { 'enabled' => true },
                    'secrets' => { 'create' => true, 'data' => { 'codeRunnerToken' => TOKEN, 'jwtSecret' => 'j', 'encryptionKey' => 'e' } } })
    secret = docs.find { |d| d['kind'] == 'Secret' }
    assert_equal TOKEN, secret['data']['code-runner-token'].unpack1('m')
  end

  def test_enabling_requires_a_token_source
    render({ 'codeRunner' => { 'enabled' => true } }, error: 'codeRunner.enabled requires')
  end

  def test_generated_token_must_be_long_enough
    render({ 'codeRunner' => { 'enabled' => true },
             'secrets' => { 'create' => true, 'data' => { 'codeRunnerToken' => 'short' } } },
           error: 'at least 32 characters')
  end

  def test_concurrency_is_bounded
    render(enabled('codeRunner' => { 'maxConcurrent' => 0 }), error: 'codeRunner.maxConcurrent')
    render(enabled('codeRunner' => { 'maxConcurrent' => 99 }), error: 'codeRunner.maxConcurrent')
  end
end
