import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

interface OrderLineItem {
  id: string;
  source_invoice_id: string;
  vendor_name: string;
  customer_name: string;
  style_number: string;
  quantity: number;
  eta_date: string | null;
  created_at: string;
  source_file_url?: string;
  notes?: string;
  needs_review: boolean;
}

const PDFJS_URL = "https://esm.sh/pdfjs-dist@3.11.174/legacy/build/pdf.mjs?target=deno";
const PDFJS_WORKER_URL = "https://esm.sh/pdfjs-dist@3.11.174/legacy/build/pdf.worker.mjs?target=deno";
const MAX_TEXT_CHARS = 15000; // prevent huge tokens on long PDFs

const EXTRACTION_PROMPT = `You are an expert at extracting wholesale apparel order data from invoices.

Extract line items from this invoice and return ONLY a valid JSON array with this exact structure:
[
  {
    "vendor_name": "string (company selling the products)",
    "customer_name": "string (company buying the products)",
    "style_number": "string (product style/model number)",
    "quantity": "integer (number of units)",
    "eta_date": "YYYY-MM-DD or null if not found",
    "notes": "string (any special notes about this line item)",
    "needs_review": "boolean (true if any required fields are unclear or missing)"
  }
]

Rules:
- Extract ALL line items from the invoice
- vendor_name: Look for "From:", "Vendor:", "Supplier:", company header, or sender info
- customer_name: Look for "To:", "Bill To:", "Ship To:", "Customer:", or recipient info
- style_number: Look for "Style:", "SKU:", "Item #:", "Product:", or similar identifiers
- quantity: Convert text like "12 pcs", "6 units" to just the number
- eta_date: Look for "ETA:", "Delivery:", "Ship Date:", "Expected:" and normalize to YYYY-MM-DD (use null if missing/ambiguous)
- Set needs_review=true if vendor_name, customer_name, or style_number are missing/unclear
- Return empty array [] if no line items found

Return ONLY the JSON array, no other text.`;

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiApiKey) {
      console.error("OpenAI API key not found");
      return new Response(JSON.stringify({ error: "OpenAI API key not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File;
    const vendorName = (formData.get("vendorName") as string) || "";
    const customerName = (formData.get("customerName") as string) || "";

    if (!file) {
      return new Response(JSON.stringify({ error: "No file provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Processing file: ${file.name}, type: ${file.type}, size: ${file.size}`);

    // Upload to Supabase Storage first (so we have a URL either way)
    const fileExt = file.name.split(".").pop();
    const fileName = `public/${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;

    const { error: uploadError } = await supabaseClient.storage
      .from("invoices")
      .upload(fileName, file, { contentType: file.type, upsert: false });
    if (uploadError) {
      console.error("Storage upload error:", uploadError);
      return new Response(JSON.stringify({ error: "Failed to upload file" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { publicUrl } } = supabaseClient.storage.from("invoices").getPublicUrl(fileName);
    console.log("File uploaded successfully:", publicUrl);

    let content: any;

    if (file.type === "application/pdf") {
      // --- PDF path: extract text with pdf.js in Deno Edge ---
      const pdfBytes = new Uint8Array(await file.arrayBuffer());
      const pdfjsLib = await import(PDFJS_URL);
      // Ensure worker is explicitly set for Edge runtimes; disable worker usage
      // to avoid cross-origin worker loading issues.
      if ((pdfjsLib as any).GlobalWorkerOptions) {
        (pdfjsLib as any).GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      }
      const loadingTask = (pdfjsLib as any).getDocument({
        data: pdfBytes,
        useWorker: false,
        isEvalSupported: false,
      });
      const pdf = await loadingTask.promise;

      let fullText = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .map((it: any) => (typeof it.str === "string" ? it.str : (it.text ?? "")))
          .join(" ");
        fullText += `\n\n--- Page ${i} ---\n${pageText}`;
        // Early stop if we exceed limit
        if (fullText.length > MAX_TEXT_CHARS) break;
      }
      if (fullText.length > MAX_TEXT_CHARS) {
        fullText = fullText.slice(0, MAX_TEXT_CHARS);
      }

      content = [
        {
          type: "text",
          text:
            `${EXTRACTION_PROMPT}\n\n` +
            `Prefilled data (use only if not clearly present in the text):\n` +
            `Vendor: "${vendorName}"\nCustomer: "${customerName}"\n\n` +
            `--- OCR/TEXT START ---\n${fullText}\n--- OCR/TEXT END ---`,
        },
      ];
    } else {
      // --- Image path: use GPT-4o Vision with inline data URI ---
      const arrayBuffer = await file.arrayBuffer();
      const base64Image = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
      const mimeType = file.type;

      content = [
        {
          type: "text",
          text:
            `${EXTRACTION_PROMPT}\n\n` +
            `Prefilled data (use if vendor/customer not found in image):\nVendor: "${vendorName}"\nCustomer: "${customerName}"`,
        },
        {
          type: "image_url",
          image_url: {
            url: `data:${mimeType};base64,${base64Image}`,
            detail: "high",
          },
        },
      ];
    }

    console.log("Calling OpenAI for extraction...");

    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content }],
        max_tokens: 2000,
        temperature: 0.1,
      }),
    });

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      console.error("OpenAI API error:", errorText);
      return new Response(
        JSON.stringify({ error: "Failed to process file with AI", details: errorText }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const openaiData = await openaiResponse.json();
    console.log("OpenAI response received");

    let extractedData: OrderLineItem[];
    try {
      const rawContent = openaiData.choices[0]?.message?.content || "[]";
      console.log("Raw AI response:", rawContent);

      const jsonMatch = rawContent.match(/\[[\s\S]*\]/);
      const jsonString = jsonMatch ? jsonMatch[0] : "[]";
      const parsedData = JSON.parse(jsonString);

      extractedData = parsedData.map((item: any, index: number) => ({
        id: `${Date.now()}-${index}`,
        source_invoice_id: fileName.replace(/\.[^/.]+$/, ""),
        vendor_name: item.vendor_name || vendorName || "",
        customer_name: item.customer_name || customerName || "",
        style_number: item.style_number || "",
        quantity: Number.parseInt(item.quantity, 10) || 0,
        eta_date: item.eta_date || null,
        created_at: new Date().toISOString(),
        source_file_url: publicUrl,
        notes: item.notes || "",
        needs_review:
          Boolean(item.needs_review) ||
          !item.vendor_name ||
          !item.customer_name ||
          !item.style_number,
      }));

      console.log(`Successfully extracted ${extractedData.length} line items`);
    } catch (parseError) {
      console.error("Failed to parse AI response:", parseError);
      extractedData = [
        {
          id: `${Date.now()}-0`,
          source_invoice_id: fileName.replace(/\.[^/.]+$/, ""),
          vendor_name: vendorName || "",
          customer_name: customerName || "",
          style_number: "",
          quantity: 0,
          eta_date: null,
          created_at: new Date().toISOString(),
          source_file_url: publicUrl,
          notes: "AI extraction failed - manual review required",
          needs_review: true,
        },
      ];
    }

    return new Response(
      JSON.stringify({ success: true, data: extractedData, source_file_url: publicUrl }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Function error:", error);
    return new Response(JSON.stringify({ error: "Internal server error", details: error?.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});