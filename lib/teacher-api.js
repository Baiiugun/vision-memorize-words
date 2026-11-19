import { SUPABASE_URL, ANON_KEY } from './config.js';

export async function login(account, password, request = fetch) {
  const code = String(account || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9]{1,31}$/.test(code)) throw new Error('请填写老师的账号简称。');
  const email = code + '@vision.example.com';
  const r = await request(SUPABASE_URL + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error('账号或密码不对（' + r.status + '）');
  const session = await r.json();
  if (!session.access_token || !session.user?.id) throw new Error('登录服务没有返回有效会话。');
  const roleUrl = SUPABASE_URL + '/rest/v1/vision_teachers?select=user_id&user_id=eq.' + encodeURIComponent(session.user.id);
  const role = await request(roleUrl, { headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + session.access_token } });
  if (!role.ok) throw new Error('当前账号的老师权限暂时无法核对。');
  const rows = await role.json();
  if (!Array.isArray(rows) || !rows.some((row) => row.user_id === session.user.id)) throw new Error('该账号还没有开通维森老师权限。');
  return session.access_token;
}
