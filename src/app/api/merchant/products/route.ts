import { desc, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db, products } from "@/db";
import { requireMerchantAuth } from "@/lib/auth/guard";
import { generateId } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const list = await db
      .select()
      .from(products)
      .orderBy(desc(products.created_at));

    return NextResponse.json(list);
  } catch (error) {
    console.error("Error listing products:", error);
    return NextResponse.json(
      { error: "Failed to list products" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const {
      id,
      variant_id,
      title,
      description,
      category,
      base_price_minor,
      stock_quantity,
      tax_rate_bps,
      returnable,
      return_window_days,
      attributes = {},
    } = body;

    if (!title || !category || base_price_minor === undefined) {
      return NextResponse.json(
        { error: "Title, category and base_price_minor are required." },
        { status: 400 },
      );
    }

    // Input validation: reject obviously invalid merchant-supplied values.
    const price = Number(base_price_minor);
    const stock = Number.isFinite(Number(stock_quantity))
      ? Math.max(0, Math.floor(Number(stock_quantity)))
      : 0;
    const taxBps = Number.isFinite(Number(tax_rate_bps))
      ? Math.max(0, Math.min(10000, Math.round(Number(tax_rate_bps))))
      : 1800;
    const windowDays = Number.isFinite(Number(return_window_days))
      ? Math.max(0, Math.min(365, Math.round(Number(return_window_days))))
      : 7;
    if (!Number.isFinite(price) || price < 0) {
      return NextResponse.json(
        { error: "base_price_minor must be a non-negative number." },
        { status: 400 },
      );
    }
    if (
      typeof title !== "string" ||
      title.trim().length === 0 ||
      title.length > 300
    ) {
      return NextResponse.json(
        { error: "title must be a non-empty string (max 300 chars)." },
        { status: 400 },
      );
    }
    if (
      typeof category !== "string" ||
      category.trim().length === 0 ||
      category.length > 100
    ) {
      return NextResponse.json(
        { error: "category must be a non-empty string (max 100 chars)." },
        { status: 400 },
      );
    }
    const safeTitle = title.trim();
    const safeCategory = category.trim();

    const merchantId = "mch_nimbus_gear_001";
    const variantId =
      variant_id ||
      `var_${safeTitle
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_")
        .slice(0, 20)}_${generateId().slice(0, 6)}`;

    if (id) {
      // Update existing (merge attributes so rating metadata survives partial updates)
      const [existing] = await db
        .select()
        .from(products)
        .where(eq(products.id, id))
        .limit(1);
      if (!existing) {
        return NextResponse.json(
          { error: "Product not found" },
          { status: 404 },
        );
      }

      const mergedAttributes = {
        ...((existing.attributes as Record<string, unknown>) || {}),
        ...attributes,
      };

      const [updated] = await db
        .update(products)
        .set({
          title: safeTitle,
          description,
          category: safeCategory,
          base_price_minor: price,
          stock_quantity: stock,
          tax_rate_bps: taxBps,
          returnable: Boolean(returnable),
          return_window_days: windowDays,
          attributes: mergedAttributes,
          version: existing.version + 1,
          updated_at: new Date(),
        })
        .where(eq(products.id, id))
        .returning();

      return NextResponse.json(updated);
    }

    // Insert new
    const newId = generateId("prod");
    const [created] = await db
      .insert(products)
      .values({
        id: newId,
        merchant_id: merchantId,
        variant_id: variantId,
        title: safeTitle,
        description,
        category: safeCategory,
        base_price_minor: price,
        stock_quantity: stock,
        tax_rate_bps: taxBps,
        returnable: returnable !== undefined ? Boolean(returnable) : true,
        return_window_days: windowDays,
        attributes,
      })
      .returning();

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error("Error saving product:", error);
    return NextResponse.json(
      { error: "Failed to save product" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json(
        { error: "Product id is required" },
        { status: 400 },
      );
    }

    await db.delete(products).where(eq(products.id, id));
    return NextResponse.json({ success: true, deletedId: id });
  } catch (error) {
    console.error("Error deleting product:", error);
    return NextResponse.json(
      { error: "Failed to delete product" },
      { status: 500 },
    );
  }
}
