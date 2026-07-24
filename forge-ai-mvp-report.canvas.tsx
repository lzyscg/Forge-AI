import { Stack, Row, Grid, H1, H2, Text, Divider, Table, Stat, Tag, Card, CardHeader, CardBody, Callout, Code } from 'qoder/canvas';

export default function ForgeAIMVPReport() {
  return (
    <Stack gap={24}>
      <H1>Forge AI MVP 开发完成报告</H1>
      <Text tone="secondary">多 Agent 协作生产平台 MVP — TypeScript/Node.js Monorepo</Text>

      <Divider />

      <H2>核心验证结果</H2>
      <Grid columns={3} gap={16}>
        <Stat value="12/12" label="完成阶段" tone="success" />
        <Stat value="64" label="单元测试通过" tone="success" />
        <Stat value="2" label="验证场景" tone="success" />
      </Grid>

      <Table
        headers={['验证项', '状态', '说明']}
        rows={[
          ['Fake Pi 全链路', '✅ 通过', '歌词场景：初稿→审核→返修→复审→交付'],
          ['真实 Pi 全链路', '✅ 通过', 'DeepSeek 模型，完整闭环验证'],
          ['崩溃恢复测试', '✅ 通过', 'waiting_recovery → running，产物未覆盖'],
          ['第二场景（零代码）', '✅ 通过', '文案场景，仅配置 YAML + 提示词'],
          ['单元测试', '✅ 64 个通过', '状态机、门禁、越界校验、崩溃恢复'],
        ]}
        rowTone={['success', 'success', 'success', 'success', 'success']}
      />

      <Divider />

      <H2>完成的 12 个阶段</H2>
      <Table
        headers={['阶段', '内容', '状态']}
        rows={[
          ['阶段一', 'Monorepo 骨架 + AGENTS.md', '✅'],
          ['阶段二', 'contracts 层类型定义', '✅'],
          ['阶段三', 'domain 层状态机 + 门禁 + 越界校验', '✅'],
          ['阶段四', 'application 层编排', '✅'],
          ['阶段五', 'adapters 层（SQLite + Fake Pi + Real Pi）', '✅'],
          ['阶段六', 'apps/worker 执行入口', '✅'],
          ['阶段七', '歌词场景配置 + Fake Pi 全链路验证', '✅'],
          ['阶段八', '真实 Pi 全链路验证（DeepSeek）', '✅'],
          ['阶段九', '崩溃恢复测试', '✅'],
          ['阶段十', '第二验证场景（零代码改动）', '✅'],
          ['阶段十一', '只读回放 Web 页面（Next.js）', '✅'],
          ['阶段十二', 'E2E 测试 + 交付整理', '✅'],
        ]}
      />

      <Divider />

      <H2>技术亮点</H2>
      <Grid columns={2} gap={16}>
        <Card>
          <CardHeader>Pi SDK 集成</CardHeader>
          <CardBody>
            <Text size="small">基于 @earendil-works/pi-ai，DeepSeek 原生支持</Text>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>五层架构</CardHeader>
          <CardBody>
            <Text size="small">contracts → domain → application → adapters → apps</Text>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>状态机</CardHeader>
          <CardBody>
            <Text size="small">Case、Turn、ArtifactVersion、Issue、RevisionInstruction</Text>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>交付门禁</CardHeader>
          <CardBody>
            <Text size="small">5 项独立检查，系统决定交付</Text>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>幂等机制</CardHeader>
          <CardBody>
            <Text size="small">(turn_id, provider_tool_call_id) 唯一索引</Text>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>崩溃恢复</CardHeader>
          <CardBody>
            <Text size="small">不覆盖已完成产物，续跑最后完成 Turn</Text>
          </CardBody>
        </Card>
      </Grid>

      <Divider />

      <H2>运行方式</H2>
      <Stack gap={12}>
        <Row gap={8}>
          <Tag tone="neutral">Fake Pi</Tag>
          <Code>./scripts/start.sh fake</Code>
        </Row>
        <Row gap={8}>
          <Tag tone="warning">Real Pi</Tag>
          <Code>DEEPSEEK_API_KEY=xxx ./scripts/start.sh real</Code>
        </Row>
        <Row gap={8}>
          <Tag tone="info">Web 回放</Tag>
          <Code>./scripts/web.sh</Code>
        </Row>
      </Stack>

      <Divider />

      <Callout tone="success" title="项目完成">
        所有 12 个阶段全部完成，核心验证目标达成：AI Agent 能够稳定跑通带返修的完整生产闭环。
      </Callout>

      <Text tone="secondary" size="small">Forge AI MVP Development Goal Completion Report</Text>
    </Stack>
  );
}
