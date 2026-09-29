import type { Metadata } from "next";

/**
 * Single source of truth for site-wide link-preview metadata.
 *
 * Next.js replaces (rather than deep-merges) nested objects like `openGraph`
 * when a child segment re-declares them, so the landing page must re-supply the
 * whole block via `openGraphFor()`. Keep the copy in one place to stop the two
 * from drifting apart.
 */

export const SITE_URL = "https://merchantgate.vercel.app";

export const TITLE = "MerchantGate | AI-Native Commerce Infrastructure";

export const DESCRIPTION =
  "Merchant infrastructure for AI buyer agents — machine-readable discovery, deterministic policy gates, authoritative time-bound quotes, and Razorpay settlement, with a full merchant console on top.";

export const OG_IMAGE = {
  url: "/og-image.jpg",
  width: 1200,
  height: 630,
  type: "image/jpeg" as const,
  alt: "MerchantGate — AI agents are the new customers. Discover, Verify, Quote, Settle.",
};

/** Open Graph + Twitter card for a specific route path, e.g. `/`. */
export function openGraphFor(path = "/") {
  return {
    type: "website" as const,
    siteName: "MerchantGate",
    locale: "en_US",
    url: path,
    title: TITLE,
    description: DESCRIPTION,
    images: [OG_IMAGE],
  };
}

export function twitterFor() {
  return {
    card: "summary_large_image" as const,
    title: TITLE,
    description: DESCRIPTION,
    images: [OG_IMAGE.url],
  };
}

/** Root layout defaults. Deliberately no `url` — every route inherits this. */
export const rootMetadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: "%s | MerchantGate",
  },
  description: DESCRIPTION,
  applicationName: "MerchantGate",
  authors: [
    {
      name: "MerchantGate",
      url: "https://github.com/priyanshuwalia/merchantgate",
    },
  ],
  creator: "MerchantGate",
  publisher: "MerchantGate",
  category: "technology",
  keywords: [
    "agentic commerce",
    "AI agent payments",
    "merchant API",
    "agentpay",
    "payment infrastructure",
    "Razorpay",
    "policy engine",
  ],
  openGraph: openGraphFor(),
  twitter: twitterFor(),
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  formatDetection: { telephone: false },
};
