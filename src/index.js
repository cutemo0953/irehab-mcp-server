#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const API_BASE = process.env.IREHAB_API_BASE || 'https://www2.denovortho.com';
const API_TOKEN = process.env.IREHAB_API_TOKEN;

if (!API_TOKEN) {
  console.error('Error: IREHAB_API_TOKEN environment variable is required.');
  console.error('Set it in your MCP config or .env file.');
  process.exit(1);
}

// PHI minimization: strip unnecessary PII before sending to AI context
function sanitizePatient(p) {
  const { credentialId, phone, email, birthdate, CredentialId, Phone, Email, Birthdate, ...safe } = p;
  if (birthdate || Birthdate) {
    const bd = birthdate || Birthdate;
    safe.age = Math.floor((Date.now() - new Date(bd).getTime()) / 31557600000);
  }
  return safe;
}

async function apiCall(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${API_TOKEN}` },
  });
  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After') || '60';
    throw new Error(`Rate limited. Please wait ${retryAfter} seconds before retrying.`);
  }
  if (res.status === 401) {
    throw new Error('Unauthorized. Check your IREHAB_API_TOKEN.');
  }
  if (!res.ok) {
    throw new Error(`API error: HTTP ${res.status}`);
  }
  return res.json();
}

const server = new Server(
  { name: 'irehab', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ── Tool Definitions (task-oriented, per spec §2C) ──

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_patients_summary',
      description: '列出我的所有病人摘要：姓名、術後天數、VAS、遵從率、復健階段、警報狀態。不含身分證/電話等個資。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_patient_trends',
      description: '查看單一病人近期趨勢：VAS 歷史 + 運動完成率。預設最近 14 天。',
      inputSchema: {
        type: 'object',
        properties: {
          patientId: { type: 'string', description: '病人 ID' },
          days: { type: 'number', description: '查詢天數（預設 14）', default: 14 },
        },
        required: ['patientId'],
      },
    },
    {
      name: 'get_low_adherence_patients',
      description: '列出遵從率低於指定門檻的病人清單。',
      inputSchema: {
        type: 'object',
        properties: {
          threshold: { type: 'number', description: '遵從率門檻%（預設 50）', default: 50 },
        },
      },
    },
    {
      name: 'get_recent_alerts',
      description: '列出有警報的病人：疼痛上升、超過 7 天未活動、遵從率偏低。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_episode_snapshot',
      description: '查看單一病人的 episode 狀態 + 里程碑達成 + 最近 PT 評估摘要。',
      inputSchema: {
        type: 'object',
        properties: {
          patientId: { type: 'string', description: '病人 ID' },
        },
        required: ['patientId'],
      },
    },
    {
      name: 'get_prom_overdue',
      description: '列出 PROM 問卷逾期待填的病人。',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

// ── Tool Implementations ──

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'list_patients_summary': {
        const data = await apiCall('/api/irehab/rehab/doctor-summary');
        const patients = (data.patients || []).map(sanitizePatient);
        return { content: [{ type: 'text', text: JSON.stringify(patients, null, 2) }] };
      }

      case 'get_patient_trends': {
        const pid = args.patientId;
        const days = args.days || 14;
        const [reports, logs] = await Promise.all([
          apiCall(`/api/irehab/report?id=${pid}`),
          apiCall(`/api/irehab/prom/status?Patient=${pid}`),
        ]);
        // Slice to recent N days
        const recentReports = (reports.ResultMessage || []).slice(0, days);
        const proms = (logs.proms || []).filter(p => p.status === 'completed');
        return { content: [{ type: 'text', text: JSON.stringify({
          patientId: pid,
          days,
          vasHistory: recentReports.map(r => ({ date: r.ReportDate, vas: r.VAS })),
          completedProms: proms.length,
          latestProm: proms[0] || null,
        }, null, 2) }] };
      }

      case 'get_low_adherence_patients': {
        const threshold = args.threshold || 50;
        const data = await apiCall('/api/irehab/rehab/doctor-summary');
        const low = (data.patients || [])
          .filter(p => p.adherence7d >= 0 && Math.round(p.adherence7d * 100) < threshold && !['completed','discharged'].includes(p.status))
          .map(p => sanitizePatient({ ...p, adherence7dPct: Math.round(p.adherence7d * 100) }));
        return { content: [{ type: 'text', text: JSON.stringify({ threshold, patients: low }, null, 2) }] };
      }

      case 'get_recent_alerts': {
        const data = await apiCall('/api/irehab/rehab/doctor-summary');
        const alerts = (data.patients || [])
          .filter(p => p.alert && p.alert !== 'none')
          .map(p => sanitizePatient({ ...p }));
        return { content: [{ type: 'text', text: JSON.stringify(alerts, null, 2) }] };
      }

      case 'get_episode_snapshot': {
        const pid = args.patientId;
        const epData = await apiCall(`/api/irehab/rehab/episodes?patientId=${pid}`);
        const episodes = (epData.episodes || []).map(ep => ({
          id: ep.id,
          status: ep.status,
          primaryProcedure: ep.primaryProcedure,
          laterality: ep.laterality,
          surgeryDate: ep.surgeryDate,
          milestones: (ep.milestones || []).map(m => ({ id: m.id, achievedAt: m.achievedAt })),
          rewardClaimed: ep.rewardClaimed,
        }));
        return { content: [{ type: 'text', text: JSON.stringify({ patientId: pid, episodes }, null, 2) }] };
      }

      case 'get_prom_overdue': {
        const data = await apiCall('/api/irehab/rehab/doctor-summary');
        const overdue = (data.patients || [])
          .filter(p => p.promStatus === 'pending')
          .map(sanitizePatient);
        return { content: [{ type: 'text', text: JSON.stringify(overdue, null, 2) }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
});

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('iRehab MCP Server running (stdio)');
}

main().catch(console.error);
