// 零 Token 探测：确认 Pi 的 deepseek provider + 模型 id 可解析（不发起模型 completion 调用）
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const rt = await ModelRuntime.create();
const provider = rt.getProvider('deepseek');
console.log('deepseek provider:', provider ? 'YES' : 'NO');

const all = rt.getModels('deepseek').map((m: any) => m.id);
console.log('deepseek models known:', all.length, all.slice(0, 12));

for (const id of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
  const m = rt.getModel('deepseek', id);
  console.log(`getModel('deepseek','${id}'):`, m ? `OK (id=${m.id})` : 'NOT FOUND');
}

// 设置 API Key（铁律 6：只从环境变量读，不写死）
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error('未设置 DEEPSEEK_API_KEY 环境变量，跳过 auth 探测');
} else {
  await rt.setRuntimeApiKey('deepseek', apiKey);
  console.log('apiKey set:', rt.hasConfiguredAuth('deepseek') ? 'configured' : 'not configured');

  const auth = await rt.getAuth('deepseek').catch((e: unknown) => `ERR ${e instanceof Error ? e.message : e}`);
  console.log('auth result:', auth);
}
