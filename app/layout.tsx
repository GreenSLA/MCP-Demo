import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'ИТИС Навигатор — помощник по КФУ',
  description:
    'Учебный MCP-агент: ответы об ИТИС по официальным источникам КФУ.',
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
