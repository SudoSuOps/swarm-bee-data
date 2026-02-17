/**
 * Swarm & Bee — Verified Download Endpoint
 *
 * Verifies Stripe checkout session, then streams product zip from R2.
 * CF Pages Function: data.swarmandbee.com/api/download?session_id=xxx&product=slug
 *
 * Environment bindings required:
 *   STRIPE_SECRET_KEY  - Stripe secret key (env var)
 *   DATA_VAULT         - R2 bucket binding (swarm-data-vault)
 */

// Product slug → R2 zip filename mapping
const PRODUCT_MAP = {
  "platinum-sample-pack":          "Platinum_Sample_Pack.zip",
  "specialty-cardiology":          "Specialty_Cardiology.zip",
  "specialty-radiology-mri":       "Specialty_Radiology_MRI.zip",
  "specialty-emergency-medicine":  "Specialty_Emergency_Medicine.zip",
  "specialty-psychiatry":          "Specialty_Psychiatry.zip",
  "specialty-pharmacology":        "Specialty_Pharmacology_Drug_Safety.zip",
  "specialty-oncology":            "Specialty_Oncology.zip",
  "specialty-neurology":           "Specialty_Neurology.zip",
  "specialty-pediatrics":          "Specialty_Pediatrics.zip",
  "specialty-womens-health":       "Specialty_Womens_Health.zip",
  "full-platinum-vault":           "Full_Platinum_Vault.zip",
  "enterprise-annual":             "Enterprise_Annual.zip",
  "pro-monthly-5k":                "Full_Platinum_Vault.zip",
  "pro-monthly-10k":               "Full_Platinum_Vault.zip",
};

// Validate Stripe session ID format
function isValidSessionId(id) {
  return /^cs_(test|live)_[a-zA-Z0-9]{10,}$/.test(id);
}

async function handleRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const isHead = request.method === "HEAD";
  const sessionId = url.searchParams.get("session_id");

  if (!sessionId || !isValidSessionId(sessionId)) {
    return new Response(isHead ? null : JSON.stringify({ error: "Invalid or missing session" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Verify the Stripe checkout session
  let session;
  try {
    const stripeRes = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
      {
        headers: {
          Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        },
      }
    );

    if (!stripeRes.ok) {
      return new Response(isHead ? null : JSON.stringify({ error: "Invalid session" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    session = await stripeRes.json();
  } catch (e) {
    return new Response(isHead ? null : JSON.stringify({ error: "Verification failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Check payment status
  if (session.payment_status !== "paid") {
    return new Response(isHead ? null : JSON.stringify({ error: "Payment not completed" }), {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Get product slug — prefer session metadata (server-side, tamper-proof)
  let productSlug = url.searchParams.get("product");

  // If session has metadata.product_slug, enforce it (prevents slug swapping)
  if (session.metadata && session.metadata.product_slug) {
    productSlug = session.metadata.product_slug;
  }

  if (!productSlug || !PRODUCT_MAP[productSlug]) {
    return new Response(isHead ? null : JSON.stringify({ error: "Unknown product" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // For HEAD requests, verification is complete — return 200
  if (isHead) {
    return new Response(null, {
      status: 200,
      headers: { "Content-Type": "application/zip" },
    });
  }

  const r2Key = `products/${PRODUCT_MAP[productSlug]}`;
  const filename = PRODUCT_MAP[productSlug];

  // Fetch from R2
  const object = await env.DATA_VAULT.get(r2Key);

  if (!object) {
    return new Response(JSON.stringify({ error: "Product file not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Stream the zip to the customer
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

// Handle both GET and HEAD requests
export const onRequestGet = handleRequest;
export const onRequestHead = handleRequest;
