import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Forge AI - 回放',
  description: '多 Agent 协作生产平台回放页面',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
