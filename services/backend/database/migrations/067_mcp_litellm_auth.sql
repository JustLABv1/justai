-- Use LiteLLM's dedicated gateway authentication header.
ALTER TABLE mcp_servers DROP CONSTRAINT mcp_servers_auth_type_check;
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_auth_type_check
    CHECK (auth_type IN ('none', 'api_key', 'oauth', 'litellm'));
