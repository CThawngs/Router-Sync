import React, { useState } from 'react';
import { useI18n } from '../i18n';

interface GuideScreenProps {
  onOpenSetup?: () => void;
  onReplayTour?: () => void;
}

export const GuideScreen: React.FC<GuideScreenProps> = ({ onOpenSetup, onReplayTour }) => {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<'start' | 'concepts' | 'faq' | 'trouble' | 'cheat'>('start');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }} data-testid="guide-screen">
      {/* Header */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px 20px', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ maxWidth: '780px' }}>
          <h1 style={{ margin: '0 0 6px 0', fontSize: '32px', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text)' }}>
            {t('g_h')}
          </h1>
          <p style={{ margin: 0, fontSize: '15px', lineHeight: 1.5, color: 'var(--muted)' }}>
            {t('g_sub')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          {onReplayTour && (
            <button
              type="button"
              data-testid="guide-replay-tour"
              onClick={onReplayTour}
              className="btn"
              style={{
                font: 'inherit',
                fontWeight: 700,
                fontSize: '14px',
                minHeight: '44px',
                padding: '0 18px',
                borderRadius: '999px',
                border: '1.5px solid var(--line)',
                cursor: 'pointer',
                background: 'var(--card)',
                color: 'var(--text)',
              }}
            >
              {t('tour_replay')}
            </button>
          )}
          {onOpenSetup && (
            <button
              onClick={onOpenSetup}
              className="btn"
              style={{
                font: 'inherit',
                fontWeight: 700,
                fontSize: '14px',
                minHeight: '44px',
                padding: '0 20px',
                borderRadius: '999px',
                border: 0,
                cursor: 'pointer',
                background: 'var(--ink)',
                color: 'var(--on-ink)',
              }}
            >
              {t('g_open')}
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div
        role="tablist"
        aria-label={t('g_tabs')}
        style={{ display: 'flex', gap: '8px', borderBottom: '1.5px solid var(--line)', paddingBottom: '12px', overflowX: 'auto' }}
      >
        {[
          { id: 'start' as const, label: t('g_tab1') },
          { id: 'concepts' as const, label: t('g_tab2') },
          { id: 'faq' as const, label: t('g_tab3') },
          { id: 'trouble' as const, label: t('g_tab4') },
          { id: 'cheat' as const, label: t('g_tab5') },
        ].map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active}
              onClick={() => {
                setActiveTab(tab.id);
                const h = window.location.hash || '#guide';
                window.location.hash = h.includes(`tab=${tab.id}`) ? h.replace(`tab=${tab.id}`, `tab=${tab.id}2`) : (h.includes('?') ? h + `&tab=${tab.id}` : h + `?tab=${tab.id}`);
              }}
              className="btn"
              style={{
                font: 'inherit',
                fontWeight: 700,
                fontSize: '15px',
                padding: '8px 18px',
                borderRadius: '999px',
                border: 0,
                cursor: 'pointer',
                background: active ? 'var(--ink)' : 'transparent',
                color: active ? 'var(--on-ink)' : 'var(--muted)',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab 1: Start */}
      {activeTab === 'start' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }} data-testid="guide-tab-start">
          {/* What is RouterSync */}
          <section
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: '24px',
              padding: '24px',
              boxShadow: 'var(--sh-card)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800 }}>{t('g_w')}</h2>
            <p style={{ margin: 0, fontSize: '15px', lineHeight: 1.6, color: 'var(--text)' }}>
              {t('g_w1')}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
              <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <b style={{ fontSize: '14px' }}>{t('g_w2')}</b>
                <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('g_w2d')}</span>
              </div>
              <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <b style={{ fontSize: '14px' }}>{t('g_w3')}</b>
                <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('g_w3d')}</span>
              </div>
              <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <b style={{ fontSize: '14px' }}>{t('g_w4')}</b>
                <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('g_w4d')}</span>
              </div>
            </div>
          </section>

          {/* Grid: What you need + Prefer AI */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }}>
            <section
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('g_n')}</h2>
              <ul style={{ margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', color: 'var(--muted)' }}>
                <li>{t('g_n1')}</li>
                <li>{t('g_n2')}</li>
                <li>{t('g_n3')}</li>
              </ul>
            </section>

            <section
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('g_a')}</h2>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)' }}>{t('g_ad')}</p>
              <ul style={{ margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', color: 'var(--text)' }}>
                <li>{t('g_a1')}</li>
                <li>{t('g_a2')}</li>
                <li>{t('g_a3')}</li>
                <li>{t('g_a4')}</li>
              </ul>
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--muted)', lineHeight: 1.4 }}>
                {t('g_an')}
              </p>
            </section>
          </div>

          {/* Install: pick one way */}
          <section
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: '24px',
              padding: '24px',
              boxShadow: 'var(--sh-card)',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('g_i')}</h2>
            <div style={{ background: 'var(--yel-t)', color: 'var(--yel-i)', borderRadius: '14px', padding: '10px 14px', fontSize: '13px' }}>
              {t('g_iw')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px' }}>
              <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <b style={{ fontSize: '14px' }}>A · {t('g_ia')}</b>
                <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('g_iad')}</span>
                <pre style={{ margin: '4px 0 0 0', padding: '8px 12px', background: 'var(--code-bg)', color: 'var(--code-fg)', borderRadius: '10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
                  npx routersync init{'\n'}npx routersync daemon
                </pre>
              </div>

              <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <b style={{ fontSize: '14px' }}>B · {t('g_ib')}</b>
                <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('g_ibd')}</span>
                <pre style={{ margin: '4px 0 0 0', padding: '8px 12px', background: 'var(--code-bg)', color: 'var(--code-fg)', borderRadius: '10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
                  git clone &lt;repo-url&gt; routersync{'\n'}cd routersync{'\n'}pnpm install && pnpm build{'\n'}npx routersync init
                </pre>
              </div>

              <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <b style={{ fontSize: '14px' }}>C · Docker</b>
                <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('g_icd')}</span>
                <pre style={{ margin: '4px 0 0 0', padding: '8px 12px', background: 'var(--code-bg)', color: 'var(--code-fg)', borderRadius: '10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
                  docker run -p 127.0.0.1:3100:3100 \{'\n'}  -v ~/.routersync:/data routersync/routersync
                </pre>
              </div>
            </div>
          </section>

          {/* First run: 5 steps */}
          <section
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: '24px',
              padding: '24px',
              boxShadow: 'var(--sh-card)',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('g_f')}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
              {[
                { step: 1, title: t('g_f1'), desc: t('g_f1d') },
                { step: 2, title: t('g_f2'), desc: t('g_f2d') },
                { step: 3, title: t('g_f3'), desc: t('g_f3d') },
                { step: 4, title: t('g_f4'), desc: t('g_f4d') },
                { step: 5, title: t('g_f5'), desc: t('g_f5d') },
              ].map((s) => (
                <div key={s.step} style={{ background: 'var(--fill)', borderRadius: '16px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'var(--ink)', color: 'var(--on-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '13px' }}>
                    {s.step}
                  </span>
                  <b style={{ fontSize: '14px', marginTop: '4px' }}>{s.title}</b>
                  <span style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.4 }}>{s.desc}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* Tab 2: Concepts */}
      {activeTab === 'concepts' && (
        <section
          style={{
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: '24px',
            padding: '24px',
            boxShadow: 'var(--sh-card)',
            display: 'flex',
            flexDirection: 'column',
            gap: '18px',
          }}
          data-testid="guide-tab-concepts"
        >
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800 }}>{t('g_c')}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: '12px' }}>
            {[
              { term: t('g_c1'), def: t('g_c1d') },
              { term: t('g_c2'), def: t('g_c2d') },
              { term: t('g_c3'), def: t('g_c3d') },
              { term: t('g_c4'), def: t('g_c4d') },
              { term: t('g_c5'), def: t('g_c5d') },
              { term: t('g_c6'), def: t('g_c6d') },
              { term: t('g_c7'), def: t('g_c7d') },
              { term: t('g_c8'), def: t('g_c8d') },
              { term: t('g_c9'), def: t('g_c9d') },
              { term: t('g_c10'), def: t('g_c10d') },
              { term: t('g_c11'), def: t('g_c11d') },
              { term: t('g_c12'), def: t('g_c12d') },
              { term: t('g_c13'), def: t('g_c13d') },
              { term: t('g_c14'), def: t('g_c14d') },
              { term: t('g_c15'), def: t('g_c15d') },
              { term: t('g_c16'), def: t('g_c16d') },
              { term: t('g_c17'), def: t('g_c17d') },
              { term: t('g_c18'), def: t('g_c18d') },
            ].map((item) => (
              <div key={item.term} style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <b style={{ fontSize: '14px' }}>{item.term}</b>
                <span style={{ fontSize: '13px', color: 'var(--muted)', lineHeight: 1.4 }}>{item.def}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Tab 3: FAQ */}
      {activeTab === 'faq' && (
        <section
          style={{
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: '24px',
            padding: '24px',
            boxShadow: 'var(--sh-card)',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          }}
          data-testid="guide-tab-faq"
        >
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800 }}>{t('g_q')}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {[
              { q: t('g_q1'), a: t('g_q1d') },
              { q: t('g_q2'), a: t('g_q2d') },
              { q: t('g_q3'), a: t('g_q3d') },
              { q: t('g_q4'), a: t('g_q4d') },
              { q: t('g_q5'), a: t('g_q5d') },
              { q: t('g_q6'), a: t('g_q6d') },
              { q: t('g_q11'), a: t('g_q11d') },
              { q: t('g_q7'), a: t('g_q7d') },
              { q: t('g_q8'), a: t('g_q8d') },
              { q: t('g_q9'), a: t('g_q9d') },
              { q: t('g_q10'), a: t('g_q10d') },
            ].map((faq) => (
              <div key={faq.q} style={{ padding: '14px 0', borderTop: '1.5px dashed var(--line)' }}>
                <div style={{ fontWeight: 700, fontSize: '15px' }}>{faq.q}</div>
                <div style={{ color: 'var(--muted)', fontSize: '14px', marginTop: '6px', lineHeight: 1.5 }}>
                  {faq.a}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Tab 4: Troubleshooting */}
      {activeTab === 'trouble' && (
        <section
          style={{
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: '24px',
            padding: '24px',
            boxShadow: 'var(--sh-card)',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          }}
          data-testid="guide-tab-trouble"
        >
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800 }}>{t('g_t')}</h2>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' }}>
              <thead>
                <tr style={{ background: 'var(--fill)', color: 'var(--muted)', fontSize: '12px', fontWeight: 700 }}>
                  <th style={{ padding: '12px 14px' }}>{t('g_th1')}</th>
                  <th style={{ padding: '12px 14px' }}>{t('g_th2')}</th>
                  <th style={{ padding: '12px 14px' }}>{t('g_th3')}</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { s: t('g_t1'), c: t('g_t1b'), a: t('g_t1c') },
                  { s: t('g_t2'), c: t('g_t2b'), a: t('g_t2c') },
                  { s: t('g_t3'), c: t('g_t3b'), a: t('g_t3c') },
                  { s: t('g_t4'), c: t('g_t4b'), a: t('g_t4c') },
                  { s: t('g_t5'), c: t('g_t5b'), a: t('g_t5c') },
                  { s: t('g_t6'), c: t('g_t6b'), a: t('g_t6c') },
                  { s: t('g_t7'), c: t('g_t7b'), a: t('g_t7c') },
                  { s: t('g_t8'), c: t('g_t8b'), a: t('g_t8c') },
                  { s: t('g_t9'), c: t('g_t9b'), a: t('g_t9c') },
                ].map((row) => (
                  <tr key={row.s} style={{ borderBottom: '1px solid var(--line)' }}>
                    <td style={{ padding: '12px 14px', fontWeight: 600 }}>{row.s}</td>
                    <td style={{ padding: '12px 14px', color: 'var(--muted)' }}>{row.c}</td>
                    <td style={{ padding: '12px 14px' }}>{row.a}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: '13px', color: 'var(--muted)', lineHeight: 1.4 }}>
            {t('g_tn')}
          </div>
        </section>
      )}

      {/* Tab 5: Commands & MCP */}
      {activeTab === 'cheat' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }} data-testid="guide-tab-cheat">
          {/* CLI cheat sheet */}
          <section
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: '24px',
              padding: '24px',
              boxShadow: 'var(--sh-card)',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800 }}>{t('g_k')}</h2>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                <thead>
                  <tr style={{ background: 'var(--fill)', color: 'var(--muted)', fontSize: '11px', fontWeight: 700 }}>
                    <th style={{ padding: '10px 14px' }}>{t('g_kh1')}</th>
                    <th style={{ padding: '10px 14px' }}>{t('g_kh2')}</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { cmd: 'routersync init', desc: t('g_k1') },
                    { cmd: 'routersync doctor', desc: t('g_k2') },
                    { cmd: 'routersync scan', desc: t('g_k3') },
                    { cmd: 'routersync plan', desc: t('g_k4') },
                    { cmd: 'routersync approve <plan_id>', desc: t('g_k5') },
                    { cmd: 'routersync apply --write', desc: t('g_k6') },
                    { cmd: 'routersync status', desc: t('g_k7') },
                    { cmd: 'routersync health --once', desc: t('g_k8') },
                    { cmd: 'routersync rollback', desc: t('g_k9') },
                    { cmd: 'routersync pause', desc: t('g_k10') },
                    { cmd: 'routersync adopt <router> <combo> --mode guard', desc: t('g_k11') },
                    { cmd: 'routersync daemon', desc: t('g_k12') },
                    { cmd: 'routersync mcp', desc: t('g_k13') },
                    { cmd: 'routersync mcp install --client <name>', desc: t('g_k17') },
                    { cmd: 'routersync adapters list', desc: t('g_k14') },
                    { cmd: 'routersync update --check', desc: t('g_k15') },
                    { cmd: 'routersync migrate', desc: t('g_k16') },
                  ].map((row) => (
                    <tr key={row.cmd} style={{ borderBottom: '1px solid var(--line)' }}>
                      <td style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{row.cmd}</td>
                      <td style={{ padding: '10px 14px', color: 'var(--muted)' }}>{row.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('g_kn')}</div>
          </section>

          {/* Grid: MCP Tools + Contribute */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }}>
            <section
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('g_m')}</h2>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)', lineHeight: 1.4 }}>{t('g_md')}</p>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ background: 'var(--fill)', color: 'var(--muted)', fontSize: '11px', fontWeight: 700 }}>
                      <th style={{ padding: '8px 10px' }}>{t('g_mh1')}</th>
                      <th style={{ padding: '8px 10px' }}>{t('g_mh2')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ borderBottom: '1px solid var(--line)' }}>
                      <td style={{ padding: '8px 10px', fontWeight: 700 }}>{t('g_m1')}</td>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)' }}>detect_routers · get_config · list_models · list_combos · status · plan · inbox_list</td>
                    </tr>
                    <tr style={{ borderBottom: '1px solid var(--line)' }}>
                      <td style={{ padding: '8px 10px', fontWeight: 700 }}>{t('g_m3')}</td>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)' }}>propose_config · propose_alias · propose_traits · propose_combo</td>
                    </tr>
                    <tr style={{ borderBottom: '1px solid var(--line)' }}>
                      <td style={{ padding: '8px 10px', fontWeight: 700 }}>{t('g_m2')}</td>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)' }}>apply(plan_id, approval_token) · rollback · pause</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('g_o')}</h2>
              <ul style={{ margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px', color: 'var(--muted)' }}>
                <li>{t('g_o1')}</li>
                <li>{t('g_o2')}</li>
                <li>{t('g_o3')}</li>
                <li>{t('g_o4')}</li>
              </ul>
            </section>
          </div>
        </div>
      )}
    </div>
  );
};
