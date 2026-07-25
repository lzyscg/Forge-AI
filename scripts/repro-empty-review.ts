// 复现 reviewer 复审返修版时的空响应：直接用一个 cold session 喂 v2 内容，dump 最终 message_end
import { RealPiAdapter } from '@forge-ai/adapters';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const apiKey = process.env.DEEPSEEK_API_KEY!;
const reviewerPrompt = readFileSync(resolve('./scenarios/songwriting/prompts/reviewer.md'), 'utf8');

// case 3 的 v2 内容（完美返修版：line 8 旋律->从前，an/ian 韵恢复）
const v2Content = `【主歌1】
月光洒在青石阶
你的脚步轻轻来
走过田埂和村寨
露水打湿了布鞋

【主歌2】
远方灯火一盏盏
山路弯弯到天边
风吹稻香在耳边
像你哼过的从前

【副歌】
你是我的山歌
唱过千遍不厌倦
你是我的山歌
飘过四季的炊烟

【桥段】
石板路上影子长
岁月悠悠不慌张
晚风捎来你的话
一朵花开在山崖

【副歌】
你是我的山歌
唱过千遍不厌倦
你是我的山歌
飘过四季的炊烟`;

const userCtx = `--- 上下文信息 ---\n[当前产物 v2]\n${v2Content}\n\n[用户输入约束]\n{\n  "reference_lyrics": "月光洒在老路上\\n你的影子在前方\\n我们走过的地方\\n花开满了山岗\\n风吹过耳旁\\n像你说的晚安",\n  "fixed_phrase": "你是我的山歌"\n}\n\n--- 任务 ---\n请审核最新版本的产物。`;

const pi = new RealPiAdapter({ modelId: process.env.PI_MODEL_ID ?? 'deepseek-v4-flash' });
const sess = await pi.createSession('reviewer', 'cold_per_version');

// 直接用 adapter 一次（内部会重试 3 次）。配合 PI_DEBUG=1 看原始事件。
const messages = [
  { role: 'system' as const, content: reviewerPrompt },
  { role: 'user' as const, content: userCtx },
];
console.log('========== reviewer 复审 v2 (cold session) ==========');
const res = await pi.executeTurn(sess, messages, []);
console.log('\n========== RESULT ==========');
console.log('finish_reason:', res.finish_reason);
console.log('tool_calls:', res.tool_calls.length, JSON.stringify(res.tool_calls).slice(0, 400));
console.log('content:', JSON.stringify(res.content)?.slice(0, 500));
if (res.error) console.log('error:', res.error);
process.exit(0);
