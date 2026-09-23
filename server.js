import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 3000);

function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = !quoted; }
    else if (ch === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) { if (ch === '\r' && text[i + 1] === '\n') i += 1; row.push(cell); cell = ''; if (row.some(value => value !== '')) rows.push(row); row = []; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift().map(h => h.replace(/^\uFEFF/, ''));
  return rows.map(values => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ''])));
}

async function loadKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  try { const content = await readFile(join(root, 'api키.txt'), 'utf8'); return content.match(/(?:OPENAI_API_KEY\s*=\s*)?(sk-[A-Za-z0-9_-]+)/)?.[1] || ''; }
  catch { return ''; }
}

async function loadCsv(filename) {
  try { return parseCsv(await readFile(join(root, filename), 'utf8')); }
  catch { return []; }
}
const [orders, observations, apiKey] = await Promise.all([
  loadCsv('예제화일 (1).csv'), loadCsv('예제화일 (2).csv'), loadKey()
]);
const numeric = value => { const number = Number.parseFloat(String(value ?? '').replace(/,/g, '')); return Number.isFinite(number) ? number : null; };
const latestBy = (rows, key = 'date') => [...rows].sort((a, b) => String(b[key]).localeCompare(String(a[key])))[0];
const patients = [...new Set(observations.map(row => row.patient_id))].map(id => {
  const history = observations.filter(row => row.patient_id === id); const latest = latestBy(history); const order = latestBy(orders.filter(row => row.patient_id === id));
  return { id, name: latest.patient_name, diagnosis: latest.diagnosis, department: latest.department, date: latest.date, hospitalDay: latest.hospital_day, icu: latest.icu_yn === 'Y', latest, order, history };
});

function criterion(label, value, threshold, unit, met, source) { return { label, value, threshold, unit, met, source: source || '자료 없음' }; }
function ransonFor(patient) {
  if (!patient.diagnosis?.includes('췌장염')) return null;
  const first = patient.history[0], after48 = patient.history.find(row => numeric(row.hospital_day) >= 3) || patient.history[2];
  const biliary = /담석|담관/.test(first.diagnosis_detail || ''); const n = key => numeric(first[key]); const a = key => numeric(after48?.[key]);
  const firstHct = n('Hct_pct'), afterHct = a('Hct_pct'), firstBun = n('BUN_mg_dL'), afterBun = a('BUN_mg_dL'), firstFluid = n('fluid_balance_24h_mL'), afterFluid = a('fluid_balance_24h_mL');
  const items = [
    criterion('나이', n('age'), biliary ? '> 70' : '> 55', '세', n('age') != null && n('age') > (biliary ? 70 : 55), '입원 시'),
    criterion('백혈구', n('WBC_10e3_uL'), biliary ? '> 18' : '> 16', '10³/µL', n('WBC_10e3_uL') != null && n('WBC_10e3_uL') > (biliary ? 18 : 16), '입원 시'),
    criterion('혈당', n('Glucose_mg_dL'), biliary ? '> 220' : '> 200', 'mg/dL', n('Glucose_mg_dL') != null && n('Glucose_mg_dL') > (biliary ? 220 : 200), '입원 시'),
    criterion('AST', n('AST_U_L'), '> 250', 'U/L', n('AST_U_L') != null && n('AST_U_L') > 250, '입원 시'),
    criterion('LDH', n('LDH_U_L'), biliary ? '> 400' : '> 350', 'U/L', n('LDH_U_L') != null && n('LDH_U_L') > (biliary ? 400 : 350), '입원 시'),
    criterion('Hct 감소', firstHct != null && afterHct != null ? firstHct - afterHct : null, '> 10', 'percentage points', firstHct != null && afterHct != null && firstHct - afterHct > 10, '48시간 자료'),
    criterion('BUN 증가', firstBun != null && afterBun != null ? afterBun - firstBun : null, '> 5', 'mg/dL', firstBun != null && afterBun != null && afterBun - firstBun > 5, '48시간 자료'),
    criterion('칼슘', a('Ca_mg_dL'), '< 8', 'mg/dL', a('Ca_mg_dL') != null && a('Ca_mg_dL') < 8, '48시간 자료'),
    criterion('PaO₂', a('PaO2_mmHg'), '< 60', 'mmHg', a('PaO2_mmHg') != null && a('PaO2_mmHg') < 60, '48시간 자료'),
    criterion('기저결핍', a('base_excess_mmol_L'), '> 4', 'mmol/L', a('base_excess_mmol_L') != null && a('base_excess_mmol_L') < -4, '48시간 자료'),
    criterion('체액 저류', firstFluid != null && afterFluid != null ? (afterFluid - firstFluid) / 1000 : null, '> 6', 'L', firstFluid != null && afterFluid != null && (afterFluid - firstFluid) / 1000 > 6, '48시간 자료')
  ];
  return { type: biliary ? '담석성 기준' : '비담석성 기준', score: items.filter(item => item.met).length, items, note: 'Ranson 점수는 입력된 시점의 자료로 계산하며, 누락된 값은 음성으로 간주하지 않고 자료 없음으로 표시해야 합니다.' };
}
function patientPayload(patient) { return { id: patient.id, name: patient.name, diagnosis: patient.diagnosis, department: patient.department, date: patient.date, hospitalDay: patient.hospitalDay, icu: patient.icu, current: patient.latest, order: patient.order, ranson: ransonFor(patient) }; }
function localSummary(patient) { const row = patient.latest; return `${patient.name} 환자는 ${patient.diagnosis}로 ${patient.department}에 재원 중입니다. 현재 ${patient.hospitalDay}일째이며 ${patient.icu ? '중환자실 치료가 필요한 상태입니다' : '일반병동에서 경과 관찰 중입니다'}. 최근 기록: ${row.notes || '특이사항 없음'}`; }

async function aiSummary(patient) {
  if (!apiKey) return { text: localSummary(patient), source: '규칙 기반 요약(OpenAI API 키 없음)' };
  // 외부 API에는 환자 이름·ID·날짜를 보내지 않고, 요약에 필요한 비식별 임상 정보만 전달한다.
  const payload = {
    diagnosis: patient.diagnosis,
    department: patient.department,
    hospitalDay: patient.hospitalDay,
    current: { ...patient.latest },
    treatment: patient.order ? { diet: patient.order.diet_order, physicianOrder: patient.order.physician_text_order } : null
  };
  for (const key of ['patient_id', 'patient_name', 'date', 'admission_date']) delete payload.current[key];  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', input: [{ role: 'system', content: '당신은 의료 기록 요약 보조자입니다. 제공된 데이터만 사용해 한국어로 진단명, 현재 상태, 주요 치료와 주의할 점을 간결하게 요약하세요. 진단·처방을 새로 내리지 말고, 불확실하면 자료 부족이라고 명시하세요. Ranson 점수는 생성하지 마세요.' }, { role: 'user', content: JSON.stringify(payload) }], max_output_tokens: 500 }), signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`OpenAI API 오류 (${response.status})`); const json = await response.json();
  return { text: json.output_text || json.output?.flatMap(item => item.content || []).map(item => item.text).filter(Boolean).join('\n') || localSummary(patient), source: 'OpenAI API 요약' };
}
function send(res, status, data, type = 'application/json; charset=utf-8') { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type.startsWith('application/json') ? JSON.stringify(data) : data); }
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/patients') return send(res, 200, patients.map(patientPayload));
    if (url.pathname.startsWith('/api/patients/') && url.pathname.endsWith('/summary')) { const id = decodeURIComponent(url.pathname.split('/')[3]); const patient = patients.find(item => item.id === id); if (!patient) return send(res, 404, { error: '환자를 찾을 수 없습니다.' }); try { return send(res, 200, { ...patientPayload(patient), summary: await aiSummary(patient) }); } catch (error) { return send(res, 200, { ...patientPayload(patient), summary: { text: localSummary(patient), source: '규칙 기반 요약(대체)' }, warning: error.name === 'AbortError' ? 'OpenAI 응답 시간 초과' : error.message }); } }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); if (file.includes('..')) return send(res, 400, { error: '잘못된 경로입니다.' });
    try { await access(join(root, file)); const body = await readFile(join(root, file)); return send(res, 200, body, extname(file) === '.html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8'); } catch { return send(res, 404, { error: '페이지를 찾을 수 없습니다.' }); }
  } catch (error) { return send(res, 500, { error: error.message }); }
}

createServer(handler).listen(Number(process.env.PORT || 3000), () => console.log("Patient summary service: http://localhost:" + (process.env.PORT || 3000)));