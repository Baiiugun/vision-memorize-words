// 学校项目的公开客户端配置。教师身份由学校数据库核验。
export const SUPABASE_URL = "https://br-great-carp-a9970f6b.supabase.aidap-global.cn-beijing.volces.com";
export const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1wbGF0Zm9ybSIsInJvbGUiOiJhbm9uIiwiZXhwIjozNjkyNDAyODA4fQ.o8OJfYkhDXl_9gEi28Zx92EHwOEH6Jwll-jOeqLUDfU";
export const BUCKET = 'vision-word-media';

export function mediaBase(slug, owner) {
  const directory = owner ? encodeURIComponent(owner) + '/' : '';
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${slug}/${directory}`;
}
