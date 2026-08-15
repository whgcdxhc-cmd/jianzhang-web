import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "简账 · 生活账本",
  description: "极速记录、自动记账、生活时间轴与搜索分析。",
  icons: {
    icon: "/icons/icon.svg",
    shortcut: "/icons/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
