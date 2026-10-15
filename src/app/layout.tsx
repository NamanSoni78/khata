import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { Toaster as SonnerToaster } from "sonner";
import { appBaseUrl } from "@/lib/app-url";

/* Brand/display face — bundled at build time (works offline in the PWA). */
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin", "latin-ext"],
  weight: ["500", "600", "700", "800"],
  display: "swap",
  variable: "--font-jakarta",
});

// Normalized (scheme guaranteed) — a scheme-less NEXT_PUBLIC_APP_URL env
// value would otherwise throw inside new URL() and 500 every page.
const APP_URL = appBaseUrl();

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: {
    default: "Khata — daily money tracker",
    template: "%s · Khata",
  },
  description:
    "Log your daily transactions by chat or voice — in English, Hindi or Hinglish. Khata is a free, private, minimal expense tracker you install as an app. Track expenses, accounts, investments and reminders effortlessly.",
  applicationName: "Khata",
  keywords: [
    "money tracker", "expense tracker", "daily expenses", "personal finance",
    "hinglish", "voice expense logging", "khata", "digital ledger",
    "expense manager india", "budget tracker", "khata app",
  ],
  manifest: "/manifest.json",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Khata",
    title: "Khata — daily money tracker",
    description:
      "Chat or speak your transactions in any mix of English or Hindi. Private, minimal, made for everyday use.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Khata — daily money tracker" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Khata — daily money tracker",
    description: "Chat or speak your transactions. Private, minimal, everyday.",
    images: ["/og.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-snippet": -1,
      "max-image-preview": "large",
    },
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Khata",
  },
  icons: {
    icon: [
      { url: "/icon-192.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icon-192.png", sizes: "192x192" }],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#008069" },
    { media: "(prefers-color-scheme: dark)", color: "#0b141a" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

// Apply saved theme before first paint (no FOUC).
const themeInit = `(function(){try{var t=localStorage.getItem('khata-theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}})();`;

// Structured data for search engines.
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "Khata",
  url: APP_URL,
  applicationCategory: "FinanceApplication",
  operatingSystem: "Web",
  description:
    "Daily money tracker you can chat with. Log expenses by voice or text in English, Hindi or Hinglish, track accounts and investments, set reminders and see where your money goes.",
  offers: { "@type": "Offer", price: "0", priceCurrency: "INR" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={jakarta.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className="font-sans">
        {children}
        <SonnerToaster
          position="top-center"
          toastOptions={{
            style: {
              borderRadius: "14px",
              background: "var(--card)",
              color: "var(--card-foreground)",
              border: "1px solid var(--border)",
              boxShadow: "var(--shadow-4)",
              fontSize: "13.5px",
            },
          }}
        />
      </body>
    </html>
  );
}
