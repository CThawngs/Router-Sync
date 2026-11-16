import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { useApi, type ApiClient, type McpClientItem } from '../api';
import { Icon } from '../components/Icon';

export type AgentClientKey = 'claude-code' | 'cursor' | 'codex' | 'hermes' | 'dsh';

interface AgentConfigInfo {
  name: string;
  descKey: string;
  cmd: string;
  configFileKey: string;
  configSnippet: string;
  checkCmd: string;
}

const AGENTS: Record<AgentClientKey, AgentConfigInfo> = {
  'claude-code': {
    name: 'Claude Code',
    descKey: 'agents_claude_desc',
    cmd: 'routersync mcp install --client claude-code --print',
    configFileKey: 'agents_claude_cfg',
    configSnippet: 'claude mcp add --transport stdio routersync node ./packages/mcp-server/dist/index.js',
    checkCmd: 'node tools/live-test/check-agent-config.mjs --client claude-code',
  },
  cursor: {
    name: 'Cursor',
    descKey: 'agents_cursor_desc',
    cmd: 'routersync mcp install --client cursor --print',
    configFileKey: 'agents_cursor_cfg',
    configSnippet: JSON.stringify(
      {
        mcpServers: {
          routersync: {
            command: 'node',
            args: ['./packages/mcp-server/dist/index.js'],
          },
        },
      },
      null,
      2
    ),
    checkCmd: 'node tools/live-test/check-agent-config.mjs --client cursor',
  },
  codex: {
    name: 'Codex CLI',
    descKey: 'agents_codex_desc',
    cmd: 'routersync mcp install --client codex --print',
    configFileKey: 'agents_codex_cfg',
    configSnippet: JSON.stringify(
      {
        mcp: {
          routersync: {
            type: 'stdio',
            command: 'node',
            args: ['./packages/mcp-server/dist/index.js'],
          },
        },
      },
      null,
      2
    ),
    checkCmd: 'node tools/live-test/check-agent-config.mjs --client codex',
  },
  hermes: {
    name: 'Hermes Desktop',
    descKey: 'agents_hermes_desc',
    cmd: 'routersync mcp install --client hermes --print',
    configFileKey: 'agents_hermes_cfg',
    configSnippet: [
      'mcp_servers:',
      '  routersync:',
      '    command: node',
      '    args:',
      '      - ./packages/mcp-server/dist/index.js',
    ].join('\n'),
    checkCmd: 'node tools/live-test/check-agent-config.mjs --client hermes',
  },
  dsh: {
    name: 'DeepSeek Harness',
    descKey: 'agents_dsh_desc',
    cmd: 'routersync mcp install --client dsh --print',
    configFileKey: 'agents_dsh_cfg',
    configSnippet: JSON.stringify(
      {
        mcpServers: {
          routersync: {
            command: 'node',
            args: ['./packages/mcp-server/dist/index.js'],
          },
        },
      },
      null,
      2
    ),
    checkCmd: 'node tools/live-test/check-agent-config.mjs --client dsh',
  },
};

interface AgentsScreenProps {
  api?: ApiClient | undefined;
}

export const AgentsScreen: React.FC<AgentsScreenProps> = ({ api: apiProp }) => {
  const { t } = useI18n();
  const contextApi = useApi();
  const api = apiProp ?? contextApi;
  const [activeClient, setActiveClient] = useState<AgentClientKey>('claude-code');
  const [protocol, setProtocol] = useState<'stdio' | 'http'>('stdio');
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [copiedCheck, setCopiedCheck] = useState(false);
  const [mcpClients, setMcpClients] = useState<McpClientItem[]>([]);

  useEffect(() => {
    let active = true;
    if (typeof api.getMcpClients === 'function') {
      api
        .getMcpClients()
        .then((data) => {
          if (active && data && Array.isArray(data.clients)) {
            setMcpClients(data.clients);
          }
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [api]);

  const current = AGENTS[activeClient];

  const activeCmd = protocol === 'stdio' ? current.cmd : 'routersync mcp serve-http';
  const activeConfig = protocol === 'stdio'
    ? current.configSnippet
    : activeClient === 'claude-code'
      ? 'claude mcp add --transport http routersync http://127.0.0.1:3128/mcp'
      : JSON.stringify({ mcpServers: { routersync: { url: 'http://127.0.0.1:3128/mcp' } } }, null, 2);
  const activeCheck = protocol === 'stdio' ? current.checkCmd : `routersync mcp pair --client ${activeClient}`;

  const handleCopyCmd = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(activeCmd);
    }
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2000);
  };

  const handleCopyConfig = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(activeConfig);
    }
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 2000);
  };

  const handleCopyCheck = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(activeCheck);
    }
    setCopiedCheck(true);
    setTimeout(() => setCopiedCheck(false), 2000);
  };

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}
      data-testid="agents-screen"
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '14px 20px',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ maxWidth: '820px' }}>
          <h1
            style={{
              margin: '0 0 6px 0',
              fontSize: '32px',
              fontWeight: 800,
              letterSpacing: '-0.02em',
              color: 'var(--text)',
            }}
          >
            {t('agents_title')}
          </h1>
          <p style={{ margin: 0, fontSize: '15px', lineHeight: 1.5, color: 'var(--muted)' }}>
            {t('agents_sub')}
          </p>
        </div>

        {/* Protocol Selector */}
        <div
          role="group"
          aria-label={t('agents_proto_aria')}
          style={{
            display: 'flex',
            background: 'var(--fill)',
            padding: '4px',
            borderRadius: '999px',
            gap: '4px',
          }}
        >
          <button
            type="button"
            className="btn"
            aria-pressed={protocol === 'stdio'}
            onClick={() => {
              setProtocol('stdio');
              const h = window.location.hash || '#agents';
              window.location.hash = h.includes('proto=stdio')
                ? h.replace('proto=stdio', 'proto=stdio2')
                : h.includes('?')
                  ? h + '&proto=stdio'
                  : h + '?proto=stdio';
            }}
            style={{
              font: 'inherit',
              fontWeight: 700,
              fontSize: '13px',
              padding: '8px 16px',
              borderRadius: '999px',
              border: 0,
              cursor: 'pointer',
              background: protocol === 'stdio' ? 'var(--card)' : 'transparent',
              color: 'var(--text)',
              boxShadow: protocol === 'stdio' ? 'var(--sh)' : 'none',
            }}
          >
            {t('agents_proto_stdio')}
          </button>
          <button
            type="button"
            className="btn"
            aria-pressed={protocol === 'http'}
            onClick={() => {
              setProtocol('http');
              const h = window.location.hash || '#agents';
              window.location.hash = h.includes('proto=http')
                ? h.replace('proto=http', 'proto=http2')
                : h.includes('?')
                  ? h + '&proto=http'
                  : h + '?proto=http';
            }}
            style={{
              font: 'inherit',
              fontWeight: 700,
              fontSize: '13px',
              padding: '8px 16px',
              borderRadius: '999px',
              border: 0,
              cursor: 'pointer',
              background: protocol === 'http' ? 'var(--card)' : 'transparent',
              color: 'var(--text)',
              boxShadow: protocol === 'http' ? 'var(--sh)' : 'none',
            }}
          >
            {t('agents_proto_http')}
          </button>
        </div>
      </div>

      {/* R49 Connected MCP Clients Banner */}
      {Array.isArray(mcpClients) && mcpClients.length > 0 && (
        <div
          data-testid="mcp-clients-banner"
          style={{
            padding: '12px 18px',
            borderRadius: '16px',
            background: 'var(--fill)',
            border: '1px solid var(--line)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 700, color: 'var(--grn-i)' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--grn)' }} />
            <span>{t('agents_connected_banner')} ({mcpClients.length})</span>
          </div>
          <div data-testid="mcp-clients-list" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {mcpClients.map((client) => (
              <span
                key={client.name}
                data-testid="mcp-client-item"
                style={{
                  fontSize: '12px',
                  padding: '4px 10px',
                  borderRadius: '999px',
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  color: 'var(--text)',
                  fontWeight: 600,
                }}
              >
                {client.name} {client.version ? `v${client.version}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Client Tab Bar */}
      <div
        role="tablist"
        aria-label={t('agents_list_aria')}
        style={{
          display: 'flex',
          gap: '8px',
          overflowX: 'auto',
          paddingBottom: '4px',
          flexWrap: 'wrap',
        }}
      >
        {(Object.keys(AGENTS) as AgentClientKey[]).map((key) => {
          const item = AGENTS[key];
          const isActive = activeClient === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className="btn"
              onClick={() => {
                setActiveClient(key);
                const h = window.location.hash || '#agents';
                window.location.hash = h.includes(`agent=${key}`)
                  ? h.replace(`agent=${key}`, `agent=${key}2`)
                  : h.includes('?')
                    ? h + `&agent=${key}`
                    : h + `?agent=${key}`;
              }}
              style={{
                font: 'inherit',
                fontWeight: 700,
                fontSize: '14px',
                minHeight: '42px',
                padding: '0 18px',
                borderRadius: '999px',
                border: isActive ? '1.5px solid var(--ink)' : '1.5px solid var(--line)',
                cursor: 'pointer',
                background: isActive ? 'var(--ink)' : 'var(--card)',
                color: isActive ? 'var(--on-ink)' : 'var(--text)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <Icon name="agents" size={16} />
              <span>{item.name}</span>
            </button>
          );
        })}
      </div>

      {/* Main Details Card */}
      <div
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: '24px',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
        }}
      >
        <div>
          <div
            style={{
              fontSize: '20px',
              fontWeight: 800,
              color: 'var(--text)',
              marginBottom: '4px',
            }}
          >
            {current.name}
          </div>
          <div style={{ fontSize: '14px', color: 'var(--muted)' }}>
            {t(current.descKey)} · {t('agents_config_file')}: <code>{t(current.configFileKey)}</code>
          </div>
        </div>

        {/* Command Box */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div
            style={{
              fontSize: '13px',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: 'var(--faint)',
            }}
          >
            {t('agents_cmd_label')}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              background: 'var(--fill)',
              borderRadius: '14px',
              padding: '12px 16px',
              flexWrap: 'wrap',
            }}
          >
            <code
              style={{
                fontFamily: 'monospace',
                fontSize: '13px',
                color: 'var(--text)',
                wordBreak: 'break-all',
              }}
            >
              {activeCmd}
            </code>
            <button
              type="button"
              className="btn"
              onClick={handleCopyCmd}
              aria-label={t('agents_copy_cmd_aria')}
              style={{
                font: 'inherit',
                fontWeight: 700,
                fontSize: '13px',
                minHeight: '38px',
                padding: '0 16px',
                borderRadius: '999px',
                border: '1px solid var(--line)',
                cursor: 'pointer',
                background: 'var(--card)',
                color: 'var(--text)',
              }}
            >
              {copiedCmd ? t('agents_copied') : t('agents_copy_cmd')}
            </button>
          </div>
        </div>

        {/* Config Snippet */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div
              style={{
                fontSize: '13px',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--faint)',
              }}
            >
              {t('agents_config_label')}
            </div>
            <button
              type="button"
              className="btn"
              onClick={handleCopyConfig}
              aria-label={t('agents_copy_config_aria')}
              style={{
                font: 'inherit',
                fontWeight: 700,
                fontSize: '13px',
                minHeight: '38px',
                padding: '0 16px',
                borderRadius: '999px',
                border: '1px solid var(--line)',
                cursor: 'pointer',
                background: 'var(--card)',
                color: 'var(--text)',
              }}
            >
              {copiedConfig ? t('agents_copied') : t('agents_copy_config')}
            </button>
          </div>
          <pre
            style={{
              margin: 0,
              padding: '16px',
              borderRadius: '14px',
              background: 'var(--fill)',
              color: 'var(--text)',
              fontFamily: 'monospace',
              fontSize: '13px',
              overflowX: 'auto',
              lineHeight: 1.5,
            }}
          >
            {activeConfig}
          </pre>
        </div>

        {/* Verification Check Command */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: '14px',
            padding: '12px 16px',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--faint)' }}>
              {t('agents_check_title')}
            </span>
            <code style={{ fontSize: '12px', fontFamily: 'monospace', color: 'var(--text)' }}>
              {activeCheck}
            </code>
          </div>
          <button
            type="button"
            className="btn"
            onClick={handleCopyCheck}
            aria-label={t('agents_copy_check_aria')}
            style={{
              font: 'inherit',
              fontWeight: 700,
              fontSize: '12px',
              minHeight: '34px',
              padding: '0 14px',
              borderRadius: '999px',
              border: '1px solid var(--line)',
              cursor: 'pointer',
              background: 'var(--fill)',
              color: 'var(--text)',
            }}
          >
            {copiedCheck ? t('agents_copied') : t('agents_check_copy')}
          </button>
        </div>

        {/* Streamable HTTP Management Instructions */}
        {protocol === 'http' && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              background: 'var(--fill)',
              borderRadius: '16px',
              padding: '16px 20px',
              border: '1px solid var(--line)',
            }}
          >
            <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text)' }}>
              {t('agents_http_instr_title')}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', color: 'var(--muted)' }}>
              <div>
                <strong>{t('agents_http_step1')}</strong> <code style={{ fontFamily: 'monospace', color: 'var(--text)' }}>routersync mcp serve-http</code>
              </div>
              <div>
                <strong>{t('agents_http_step2')}</strong> <code style={{ fontFamily: 'monospace', color: 'var(--text)' }}>routersync mcp pair --client &lt;client&gt;</code>
              </div>
              <div>
                <strong>{t('agents_http_step3')}</strong> <code style={{ fontFamily: 'monospace', color: 'var(--text)' }}>routersync mcp revoke &lt;tokenId&gt;</code>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Security Guarantees Callout */}
      <div
        style={{
          background: 'var(--fill)',
          borderRadius: '20px',
          padding: '18px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        <strong style={{ fontSize: '15px', color: 'var(--text)' }}>
          {t('agents_sec_title')}
        </strong>
        <span style={{ fontSize: '14px', lineHeight: 1.5, color: 'var(--muted)' }}>
          {protocol === 'stdio' ? t('agents_sec_body') : t('agents_sec_http')}
        </span>
      </div>
    </div>
  );
};
