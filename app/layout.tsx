import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CMF CreditView · Inteligencia crediticia para Chile",
  description: "Plataforma profesional de análisis de riesgo de crédito para emisores chilenos.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
