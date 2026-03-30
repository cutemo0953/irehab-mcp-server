#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const API_BASE = process.env.IREHAB_API_BASE || 'https://www2.denovortho.com';
const API_TOKEN = process.env.IREHAB_API_TOKEN;
const ADMIN_KEY = process.env.IREHAB_ADMIN_KEY || '';

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

async function apiWrite(path, method, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (res.status === 403) throw new Error('Insufficient scope. Enable write permissions in Doctor PWA Profile.');
  if (res.status === 409) throw new Error('Draft collision: existing draft pending. Confirm or delete it in Doctor PWA first.');
  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After') || '60';
    throw new Error(`Write rate limited. Wait ${retryAfter}s.`);
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`API error: HTTP ${res.status} — ${errBody}`);
  }
  return res.json();
}

async function adminApiCall(path) {
  if (!ADMIN_KEY) {
    throw new Error('IREHAB_ADMIN_KEY not set. Admin analytics tools require the admin API key.');
  }
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'X-API-Key': ADMIN_KEY },
  });
  if (res.status === 401) {
    throw new Error('Unauthorized. Check your IREHAB_ADMIN_KEY.');
  }
  if (!res.ok) {
    throw new Error(`API error: HTTP ${res.status}`);
  }
  return res.json();
}

const server = new Server(
  { name: 'irehab', version: '2.2.0' },
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
    {
      name: 'draft_prescription',
      description: '為病人建立處方草稿。草稿需醫師在 Doctor PWA 確認後才會生效。建議先用 list_exercise_library 查詢可用 exerciseId。',
      inputSchema: {
        type: 'object',
        properties: {
          patientId: { type: 'string', description: '病人 ID' },
          weekNumber: { type: 'number', description: '週數' },
          phase: { type: 'number', description: '復健階段 (1-4)', minimum: 1, maximum: 4 },
          exercises: {
            type: 'array',
            minItems: 1,
            description: '處方運動列表',
            items: {
              type: 'object',
              properties: {
                exerciseId: { type: 'string' },
                sets: { type: 'number', minimum: 1 },
                reps: { type: 'number', minimum: 1 },
                holdSec: { type: 'number', minimum: 0 },
                frequency: { type: 'string' },
                notes: { type: 'string', maxLength: 500 },
              },
              required: ['exerciseId', 'sets', 'reps', 'frequency'],
            },
          },
          notes: { type: 'string', maxLength: 1000 },
        },
        required: ['patientId', 'exercises'],
      },
    },
    {
      name: 'draft_assessment',
      description: '為病人建立評估草稿。草稿需醫師在 Doctor PWA 確認後才生效。建議先用 get_patient_trends 和 get_episode_snapshot 查詢病人近期狀態。',
      inputSchema: {
        type: 'object',
        properties: {
          patientId: { type: 'string', description: '病人 ID' },
          phase: { type: 'number', description: '復健階段 (1-4)', minimum: 1, maximum: 4 },
          rom: {
            type: 'object',
            properties: {
              kneeFlexion: { type: 'number', minimum: 0, maximum: 180 },
              kneeExtension: { type: 'number', minimum: -30, maximum: 30 },
              measurementMethod: { type: 'string', enum: ['goniometer', 'visual_estimate', 'digital'] },
            },
          },
          painVAS: { type: 'number', description: '0-10', minimum: 0, maximum: 10 },
          effusionGrade: { type: 'string', enum: ['none', 'trace', 'mild', 'moderate', 'severe'] },
          progressionDecision: { type: 'string', enum: ['advance', 'maintain', 'regress'] },
          progressionRationale: { type: 'string', maxLength: 1000 },
          subjectiveNotes: { type: 'string', maxLength: 2000 },
          objectiveNotes: { type: 'string', maxLength: 2000 },
          assessmentNotes: { type: 'string', maxLength: 2000 },
          planNotes: { type: 'string', maxLength: 2000 },
          setting: { type: 'string', enum: ['clinic', 'telehealth'] },
        },
        required: ['patientId', 'phase', 'progressionDecision'],
      },
    },
    {
      name: 'list_exercise_library',
      description: '列出可用的運動庫，用於建立處方時選擇正確的 exerciseId。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'draft_surgical_record',
      description: '為病人建立術式紀錄草稿（§A 手術資訊 + §B 植入物 + §C 使用醫材 + §D 出院資訊）。草稿需醫師在 Doctor PWA 確認後才成為正式紀錄。建議先用 get_episode_snapshot 查詢病人的 procedure/laterality/surgeryDate。',
      inputSchema: {
        type: 'object',
        properties: {
          patientId: { type: 'string', description: '病人 ID' },
          // §A Surgery Info
          surgicalApproach: { type: 'string', enum: ['posterior', 'anterior', 'DAA', 'lateral', 'medial_parapatellar', 'anterolateral', 'direct_lateral', 'posterolateral', 'Hardinge'] },
          fixationType: { type: 'string', enum: ['cemented', 'uncemented', 'hybrid', 'reverse_hybrid'] },
          anesthesiaType: { type: 'string', enum: ['general', 'spinal', 'epidural', 'regional_block'] },
          asaGrade: { type: 'number', minimum: 1, maximum: 5 },
          procedureSubtype: { type: 'string', enum: ['primary_elective', 'fracture_related', 'revision'] },
          diagnosis: { type: 'string', enum: ['OA', 'AVN', 'fracture', 'RA', 'dysplasia', 'other'] },
          navigationAssisted: { type: 'boolean' },
          robotSystem: { type: 'string', enum: ['MAKO', 'ROSA', 'NAVIO', ''] },
          // §B Implants
          implants: { type: 'array', items: { type: 'object', properties: { component: { type: 'string', enum: ['femoral', 'tibial', 'patellar', 'acetabular', 'femoral_head', 'liner', 'stem'] }, manufacturer: { type: 'string' }, model: { type: 'string' }, size: { type: 'string' }, lotNumber: { type: 'string' }, fixation: { type: 'string', enum: ['cemented', 'uncemented'] } }, required: ['component', 'manufacturer', 'model'] } },
          // §C Intraop Materials
          intraopMaterials: { type: 'array', items: { type: 'object', properties: { productName: { type: 'string' }, brand: { type: 'string' }, category: { type: 'string' }, quantity: { type: 'number', minimum: 1 } }, required: ['productName', 'quantity'] } },
          // §D Discharge
          losNights: { type: 'number', minimum: 0, maximum: 365 },
          dischargeDisposition: { type: 'string', enum: ['home', 'snf', 'inpatient_rehab', 'ltac', 'other'] },
          dischargeAmbulation: { type: 'string', enum: ['independent', 'cane', 'walker', 'wheelchair', 'non_ambulatory'] },
          pod1Mobilization: { type: 'boolean' },
          // §F Optional
          operativeTimeMinutes: { type: 'number', minimum: 0 },
          estimatedBloodLossMl: { type: 'number', minimum: 0 },
          vteProphylaxis: { type: 'string', maxLength: 200 },
          transfusion: { type: 'boolean' },
        },
        required: ['patientId'],
      },
    },
    {
      name: 'draft_billing',
      description: '為病人建立自費計費紀錄草稿。支援用品名搜尋產品。草稿需醫師在 Doctor PWA 確認後才正式記錄。',
      inputSchema: {
        type: 'object',
        properties: {
          patientId: { type: 'string' },
          items: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', properties: { productName: { type: 'string' }, nhiCode: { type: 'string' }, quantity: { type: 'number', minimum: 1, default: 1 }, unitPrice: { type: 'number' }, note: { type: 'string', maxLength: 500 } }, required: ['productName', 'quantity'] } },
          hospitalContext: { type: 'string' },
          nhiOnly: { type: 'boolean' },
        },
        required: ['patientId', 'items'],
      },
    },
    // ── Customer Intelligence Tools (Admin, read-only) ──
    {
      name: 'get_invite_stats',
      description: '查詢邀請碼統計：近 30 天申請數、來源分佈、醫院分佈、轉換率、待使用邀請碼數。需要 IREHAB_ADMIN_KEY。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_user_activity',
      description: '查詢用戶活動概況：醫師/病患總數、7/30 天活躍數、新註冊數、VAS 回報數。需要 IREHAB_ADMIN_KEY。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_churn_risk',
      description: '查詢流失風險：列出 N 天內未活動的醫師和病患。預設 7 天。需要 IREHAB_ADMIN_KEY。',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '不活躍天數門檻（預設 7）', default: 7 },
        },
      },
    },
    {
      name: 'get_customer_summary',
      description: '一鍵查詢客戶全貌：邀請碼、用戶活動、WishPool 排行、活躍 episode 數。需要 IREHAB_ADMIN_KEY。',
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

      case 'draft_prescription': {
        const pid = args.patientId;
        // Preflight: find active episode
        const epData = await apiCall(`/api/irehab/rehab/episodes?patientId=${pid}`);
        const episodes = epData.episodes || [];
        const active = episodes.find(e => e.status === 'active' || e.status === 'prehab');
        if (!active) throw new Error('No active episode found for this patient.');

        const body = {
          phase: args.phase || active.currentPhase || 1,
          weekNumber: args.weekNumber || 1,
          exercises: (args.exercises || []).map(ex => ({
            exerciseId: ex.exerciseId,
            sets: ex.sets,
            reps: ex.reps,
            holdSec: ex.holdSec || 0,
            frequency: ex.frequency,
            notes: ex.notes || '',
          })),
        };
        if (args.notes) body.notes = args.notes;

        const result = await apiWrite(`/api/irehab/rehab/prescription?episodeId=${active.id}`, 'POST', body);
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'draft_created',
          draftId: result.rxId,
          episodeId: active.id,
          requiresClinicianConfirmation: true,
          message: '處方草稿已建立，等待醫師在 Doctor PWA 確認。',
        }, null, 2) }] };
      }

      case 'draft_assessment': {
        const pid = args.patientId;
        const epData = await apiCall(`/api/irehab/rehab/episodes?patientId=${pid}`);
        const episodes = epData.episodes || [];
        const active = episodes.find(e => e.status === 'active' || e.status === 'prehab');
        if (!active) throw new Error('No active episode found for this patient.');

        const body = {
          phase: args.phase,
          date: new Date().toISOString().split('T')[0],
          setting: args.setting || 'telehealth',
          progressionDecision: args.progressionDecision,
        };
        if (args.rom) body.rom = args.rom;
        if (args.painVAS != null) body.painVAS = args.painVAS;
        if (args.effusionGrade) body.effusionGrade = args.effusionGrade;
        if (args.progressionRationale) body.progressionRationale = args.progressionRationale;
        if (args.subjectiveNotes) body.subjectiveNotes = args.subjectiveNotes;
        if (args.objectiveNotes) body.objectiveNotes = args.objectiveNotes;
        if (args.assessmentNotes) body.assessmentNotes = args.assessmentNotes;
        if (args.planNotes) body.planNotes = args.planNotes;

        const result = await apiWrite(`/api/irehab/rehab/assessment?episodeId=${active.id}`, 'POST', body);
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'draft_created',
          draftId: result.assessmentId,
          episodeId: active.id,
          requiresClinicianConfirmation: true,
          message: '評估草稿已建立，等待醫師在 Doctor PWA 確認。',
        }, null, 2) }] };
      }

      case 'list_exercise_library': {
        const data = await apiCall('/api/irehab/rehab/exercises');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'draft_surgical_record': {
        const pid = args.patientId;
        // Preflight: find active episode
        const epData = await apiCall(`/api/irehab/rehab/episodes?patientId=${pid}`);
        const episodes = epData.episodes || [];
        const active = episodes.find(e => e.status === 'active' || e.status === 'prehab');
        if (!active) throw new Error('No active episode found for this patient.');

        // Build payload with all provided fields
        const body = {};
        // §A Surgery Info
        if (args.surgicalApproach) body.surgicalApproach = args.surgicalApproach;
        if (args.fixationType) body.fixationType = args.fixationType;
        if (args.anesthesiaType) body.anesthesiaType = args.anesthesiaType;
        if (args.asaGrade != null) body.asaGrade = args.asaGrade;
        if (args.procedureSubtype) body.procedureSubtype = args.procedureSubtype;
        if (args.diagnosis) body.diagnosis = args.diagnosis;
        if (args.navigationAssisted != null) body.navigationAssisted = args.navigationAssisted;
        if (args.robotSystem != null) body.robotSystem = args.robotSystem;
        // §B Implants
        if (args.implants) body.implants = args.implants;
        // §C Intraop Materials
        if (args.intraopMaterials) body.intraopMaterials = args.intraopMaterials;
        // §D Discharge
        if (args.losNights != null) body.losNights = args.losNights;
        if (args.dischargeDisposition) body.dischargeDisposition = args.dischargeDisposition;
        if (args.dischargeAmbulation) body.dischargeAmbulation = args.dischargeAmbulation;
        if (args.pod1Mobilization != null) body.pod1Mobilization = args.pod1Mobilization;
        // §F Optional
        if (args.operativeTimeMinutes != null) body.operativeTimeMinutes = args.operativeTimeMinutes;
        if (args.estimatedBloodLossMl != null) body.estimatedBloodLossMl = args.estimatedBloodLossMl;
        if (args.vteProphylaxis) body.vteProphylaxis = args.vteProphylaxis;
        if (args.transfusion != null) body.transfusion = args.transfusion;

        // Track missing required fields
        const missingRequiredFields = [];
        if (!args.surgicalApproach) missingRequiredFields.push('surgicalApproach');
        if (!args.fixationType) missingRequiredFields.push('fixationType');
        if (!args.implants || args.implants.length === 0) missingRequiredFields.push('implants');
        if (args.losNights == null) missingRequiredFields.push('losNights');
        if (!args.dischargeDisposition) missingRequiredFields.push('dischargeDisposition');

        // Track missing recommended fields
        const missingRecommendedFields = [];
        if (args.implants && args.implants.length > 0) {
          const missingLot = args.implants.some(imp => !imp.lotNumber);
          if (missingLot) missingRecommendedFields.push('lotNumber (some implants)');
        }
        if (args.estimatedBloodLossMl == null) missingRecommendedFields.push('estimatedBloodLossMl');
        if (args.operativeTimeMinutes == null) missingRecommendedFields.push('operativeTimeMinutes');
        if (!args.anesthesiaType) missingRecommendedFields.push('anesthesiaType');

        const result = await apiWrite(`/api/irehab/episode/${active.id}/surgical-record`, 'POST', body);
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'draft_created',
          draftId: result.surgicalRecordId,
          episodeId: active.id,
          missingRequiredFields,
          missingRecommendedFields,
          requiresClinicianConfirmation: true,
          message: '術式紀錄草稿已建立，等待醫師在 Doctor PWA 確認。',
        }, null, 2) }] };
      }

      case 'draft_billing': {
        const pid = args.patientId;
        // Preflight: find active episode
        const epData = await apiCall(`/api/irehab/rehab/episodes?patientId=${pid}`);
        const episodes = epData.episodes || [];
        const active = episodes.find(e => e.status === 'active' || e.status === 'prehab');
        if (!active) throw new Error('No active episode found for this patient.');

        const hospitalContext = args.hospitalContext || '';
        const itemResults = [];

        // For each item: search products via BFF, apply confidence threshold
        for (const item of args.items) {
          const query = item.nhiCode || item.productName;
          let searchUrl = `/api/irehab/billing/products/search?q=${encodeURIComponent(query)}`;
          if (hospitalContext) searchUrl += `&hospitalId=${encodeURIComponent(hospitalContext)}`;
          if (args.nhiOnly) searchUrl += `&nhiOnly=true`;

          let matched = null;
          let matchStatus = 'manual_required';
          try {
            const searchResult = await apiCall(searchUrl);
            const candidates = searchResult.products || [];

            if (candidates.length > 0) {
              const top = candidates[0];
              const isExactMatch = top.matchStrategy === 'exact_nhi' || top.matchStrategy === 'exact_name';
              const isHighConfidence = top.matchConfidence >= 0.85 && candidates.length <= 3;

              if (isExactMatch || isHighConfidence) {
                matched = {
                  productId: top.productId,
                  productName: top.productName,
                  nhiCode: top.nhiCode || null,
                  unitPrice: item.unitPrice || top.unitPrice,
                  matchStrategy: top.matchStrategy,
                  matchConfidence: top.matchConfidence,
                };
                matchStatus = 'auto_matched';
              } else {
                matched = {
                  productName: item.productName,
                  unitPrice: item.unitPrice || null,
                  candidateCount: candidates.length,
                  topCandidate: { productId: top.productId, productName: top.productName, matchConfidence: top.matchConfidence },
                };
                matchStatus = 'ambiguous';
              }
            }
          } catch (searchErr) {
            matched = { productName: item.productName, unitPrice: item.unitPrice || null, error: searchErr.message };
            matchStatus = 'search_failed';
          }

          itemResults.push({
            requestedName: item.productName,
            quantity: item.quantity,
            note: item.note || '',
            matchStatus,
            matched,
          });
        }

        // Build billing record payload
        const billingItems = itemResults
          .filter(ir => ir.matchStatus === 'auto_matched')
          .map(ir => ({
            productId: ir.matched.productId,
            productName: ir.matched.productName,
            nhiCode: ir.matched.nhiCode,
            quantity: ir.quantity,
            unitPrice: ir.matched.unitPrice,
            note: ir.note,
          }));

        let billingResult = null;
        if (billingItems.length > 0) {
          billingResult = await apiWrite('/api/irehab/billing/record', 'POST', {
            episodeId: active.id,
            patientId: pid,
            hospitalContext,
            items: billingItems,
          });
        }

        const autoMatchedCount = itemResults.filter(ir => ir.matchStatus === 'auto_matched').length;
        const ambiguousCount = itemResults.filter(ir => ir.matchStatus === 'ambiguous').length;
        const failedCount = itemResults.filter(ir => ir.matchStatus === 'manual_required' || ir.matchStatus === 'search_failed').length;

        return { content: [{ type: 'text', text: JSON.stringify({
          status: billingResult ? 'draft_created' : 'no_items_matched',
          billingRecordId: billingResult?.billingRecordId || null,
          episodeId: active.id,
          summary: {
            totalItems: args.items.length,
            autoMatched: autoMatchedCount,
            ambiguous: ambiguousCount,
            manualRequired: failedCount,
          },
          itemResults,
          requiresClinicianConfirmation: true,
          message: billingResult
            ? '自費計費草稿已建立，等待醫師在 Doctor PWA 確認。'
            : '未能自動匹配任何品項，請在 Doctor PWA 手動選取產品。',
        }, null, 2) }] };
      }

      // ── Customer Intelligence Tools ──

      case 'get_invite_stats': {
        const data = await adminApiCall('/api/irehab/admin/analytics/invites');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'get_user_activity': {
        const data = await adminApiCall('/api/irehab/admin/analytics/activity');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'get_churn_risk': {
        const days = args.days || 7;
        const data = await adminApiCall(`/api/irehab/admin/analytics/churn?days=${days}`);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'get_customer_summary': {
        const data = await adminApiCall('/api/irehab/admin/analytics/summary');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
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
