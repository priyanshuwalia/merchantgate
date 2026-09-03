import "dotenv/config";
import { eq } from "drizzle-orm";
import { agents, db, merchants, products } from "./index";

export async function seedDatabase() {
  console.log("🌱 Starting AgentPay Merchant Database Seed...");

  // 1. Merchant
  const merchantId = "mch_nimbus_gear_001";
  const existingMerchant = await db
    .select()
    .from(merchants)
    .where(eq(merchants.id, merchantId));

  if (existingMerchant.length === 0) {
    await db.insert(merchants).values({
      id: merchantId,
      name: "Nimbus Gear & Electronics",
      api_key_hash: "hash_demo_1234567890",
      webhook_secret:
        process.env.RAZORPAY_WEBHOOK_SECRET || "rzp_webhook_secret_default",
      status: "active",
      config: {
        currency: "INR",
        autoProcessAgentOrders: false,
        agentRequiresApproval: true,
        maxAgentTransactionAmount: 5000000, // ₹50,000.00 (supports bulk AI-buyer orders)
        priceSlippageToleranceBps: 200, // 2%
        razorpayKeyId: process.env.RAZORPAY_KEY_ID || "rzp_test_simulated_key",
      },
    });
    console.log("✅ Seeded default merchant: Nimbus Gear & Electronics");
  } else {
    console.log("ℹ️ Default merchant already exists.");
  }

  // 2. Sample Products
  const sampleProducts = [
    {
      id: "prod_kbd_nimbus_75",
      merchant_id: merchantId,
      variant_id: "kbd_nimbus_75_black_brown",
      title: "Nimbus 75 Mechanical Keyboard (Gateron Brown)",
      description:
        "Compact 75% hot-swappable mechanical keyboard with RGB backlighting, custom dampening foam, and tactile brown switches.",
      category: "electronics",
      attributes: {
        switchType: "Gateron Brown",
        layout: "75%",
        connectivity: "Tri-mode (2.4G / BT / Type-C)",
        color: "Obsidian Black",
        ratingAverage: 4.8,
        ratingCount: 428,
      },
      base_price_minor: 349900, // ₹3,499.00
      currency: "INR",
      tax_rate_bps: 1800, // 18% GST
      returnable: true,
      return_window_days: 7,
      stock_quantity: 45,
      version: 1,
    },
    {
      id: "prod_mse_nimbus_pro",
      merchant_id: merchantId,
      variant_id: "mse_nimbus_pro_white",
      title: "Nimbus Pro Wireless Ultralight Gaming Mouse",
      description:
        "58g ultralight wireless gaming mouse featuring 26K DPI optical sensor and 80-hour battery life.",
      category: "electronics",
      attributes: {
        weight: "58g",
        dpi: "26000",
        sensor: "PAW3395",
        color: "Matte White",
        ratingAverage: 4.6,
        ratingCount: 312,
      },
      base_price_minor: 189900, // ₹1,899.00
      currency: "INR",
      tax_rate_bps: 1800,
      returnable: true,
      return_window_days: 7,
      stock_quantity: 80,
      version: 1,
    },
    {
      id: "prod_aud_nimbus_anc",
      merchant_id: merchantId,
      variant_id: "aud_nimbus_anc_pro",
      title: "Nimbus Studio ANC Wireless Headphones",
      description:
        "Active noise cancelling over-ear studio headphones with spatial audio and 40mm beryllium drivers.",
      category: "audio",
      attributes: {
        driverSize: "40mm Beryllium",
        batteryHours: "45h",
        ancLevel: "-42dB",
        ratingAverage: 4.7,
        ratingCount: 189,
      },
      base_price_minor: 649900, // ₹6,499.00
      currency: "INR",
      tax_rate_bps: 1800,
      returnable: true,
      return_window_days: 14,
      stock_quantity: 30,
      version: 1,
    },
    {
      id: "prod_acc_nimbus_stand",
      merchant_id: merchantId,
      variant_id: "acc_nimbus_stand_alu",
      title: "Ergonomic Aluminum Foldable Laptop Stand",
      description:
        "Aerospace-grade CNC aluminum adjustable ergonomic laptop riser with silicone non-slip pads.",
      category: "accessories",
      attributes: {
        material: "CNC Aluminum",
        compatibility: "11-17 inch laptops",
        angles: "6 adjustable levels",
        ratingAverage: 4.5,
        ratingCount: 520,
      },
      base_price_minor: 129900, // ₹1,299.00
      currency: "INR",
      tax_rate_bps: 1800,
      returnable: true,
      return_window_days: 30,
      stock_quantity: 100,
      version: 1,
    },
    {
      id: "prod_mon_apex_27",
      merchant_id: merchantId,
      variant_id: "mon_apex_27_4k",
      title: "Apex 27-inch 4K UHD IPS Designer Monitor",
      description:
        "Factory calibrated 4K UHD (3840x2160) IPS display with 99% DCI-P3 color gamut and 90W USB-C PD.",
      category: "electronics",
      attributes: {
        resolution: "3840x2160 (4K)",
        panel: "IPS 10-bit",
        colorAccuracy: "Delta E < 2",
        usbCPower: "90W",
        ratingAverage: 4.4,
        ratingCount: 74,
      },
      base_price_minor: 2499900, // ₹24,999.00
      currency: "INR",
      tax_rate_bps: 1800,
      returnable: true,
      return_window_days: 7,
      stock_quantity: 15,
      version: 1,
    },
    {
      id: "prod_lap_gaming_pro",
      merchant_id: merchantId,
      variant_id: "laptop_gaming_pro",
      title: "Apex RTX Studio 16 High-Performance Gaming Laptop",
      description:
        "Flagship laptop equipped with Core i9, RTX 4080 12GB, 32GB DDR5 RAM, and 2TB NVMe SSD.",
      category: "computers",
      attributes: {
        cpu: "Intel Core i9-14900HX",
        gpu: "NVIDIA RTX 4080 12GB",
        ram: "32GB DDR5",
        storage: "2TB NVMe Gen4",
        ratingAverage: 4.3,
        ratingCount: 38,
      },
      base_price_minor: 12999900, // ₹1,29,999.00
      currency: "INR",
      tax_rate_bps: 1800,
      returnable: true,
      return_window_days: 7,
      stock_quantity: 5,
      version: 1,
    },
    {
      id: "prod_acc_nimbus_deskmat",
      merchant_id: merchantId,
      variant_id: "acc_nimbus_deskmat",
      title: "Nimbus Desk Mat (900x400mm, Stitched Edition)",
      description:
        "Extra-large desk mat with 3-day pro tapered stitched edges, water-resistant microfiber surface, and non-slip natural rubber base.",
      category: "accessories",
      attributes: {
        material: "Microfiber + Natural Rubber",
        size: "900x400x3mm",
        ratingAverage: 4.7,
        ratingCount: 210,
      },
      base_price_minor: 19900, // ₹199.00
      currency: "INR",
      tax_rate_bps: 1800,
      returnable: true,
      return_window_days: 30,
      stock_quantity: 250,
      version: 1,
    },
    {
      id: "prod_acc_nimbus_switch_set",
      merchant_id: merchantId,
      variant_id: "acc_nimbus_switch_set",
      title: "Nimbus Tactile Switch Starter Set (35 pcs)",
      description:
        "35-piece pre-lubed tactile switch sampler for hot-swappable mechanical keyboards, matching the Gateron Brown feel.",
      category: "accessories",
      attributes: {
        switchType: "Tactile (pre-lubed)",
        count: 35,
        compatibility: "3-pin / 5-pin hot-swap",
        ratingAverage: 4.6,
        ratingCount: 145,
      },
      base_price_minor: 12900, // ₹129.00
      currency: "INR",
      tax_rate_bps: 1800,
      returnable: false,
      return_window_days: 7,
      stock_quantity: 180,
      version: 1,
    },
    {
      id: "prod_acc_kbd_wristrest",
      merchant_id: merchantId,
      variant_id: "acc_kbd_wristrest",
      title: "Memory Foam Wrist Rest (75% Layout, Matte Black)",
      description:
        "Plush memory-foam wrist rest with fabric mesh top and non-slip base, sized for 75% mechanical keyboards.",
      category: "accessories",
      attributes: {
        material: "Memory Foam + Mesh",
        fit: "60% / 75% / TKL",
        ratingAverage: 4.4,
        ratingCount: 96,
      },
      base_price_minor: 9900, // ₹99.00
      currency: "INR",
      tax_rate_bps: 1800,
      returnable: true,
      return_window_days: 30,
      stock_quantity: 320,
      version: 1,
    },
    {
      id: "prod_acc_nimbus_charger",
      merchant_id: merchantId,
      variant_id: "acc_nimbus_charger",
      title: "Nimbus 65W GaN USB-C Fast Charger",
      description:
        "Pocket-sized 65W GaN charger with dual USB-C + USB-A ports (PD 3.0, PPS) — fast-charges phones, tablets, and 14-inch laptops.",
      category: "accessories",
      attributes: {
        wattage: "65W GaN",
        ports: "2x USB-C, 1x USB-A",
        protocol: "PD 3.0 / PPS / QC 4+",
        ratingAverage: 4.8,
        ratingCount: 402,
      },
      base_price_minor: 15900, // ₹159.00
      currency: "INR",
      tax_rate_bps: 1800,
      returnable: true,
      return_window_days: 30,
      stock_quantity: 150,
      version: 1,
    },
    {
      id: "prod_acc_headphone_stand",
      merchant_id: merchantId,
      variant_id: "acc_headphone_stand",
      title: "Aluminum Headphone Stand with USB Hub",
      description:
        "Heavyweight aluminum headphone stand with a 3-port USB 3.0 hub and integrated cable management.",
      category: "accessories",
      attributes: {
        material: "Aluminum Alloy",
        ports: "3x USB 3.0",
        ratingAverage: 4.3,
        ratingCount: 88,
      },
      base_price_minor: 22900, // ₹229.00
      currency: "INR",
      tax_rate_bps: 1800,
      returnable: true,
      return_window_days: 30,
      stock_quantity: 120,
      version: 1,
    },
    {
      id: "prod_acc_lap_sleeve",
      merchant_id: merchantId,
      variant_id: "acc_lap_sleeve",
      title: "Nimbus 16-inch Slim Laptop Sleeve (Water-Resistant)",
      description:
        "Barely-there 16-inch laptop sleeve with soft-touch recycled exterior, fuzz-free lining, and magnetic closure.",
      category: "accessories",
      attributes: {
        fits: "Up to 16-inch laptops",
        material: "Recycled PET + Felt",
        ratingAverage: 4.5,
        ratingCount: 67,
      },
      base_price_minor: 17900, // ₹179.00
      currency: "INR",
      tax_rate_bps: 1800,
      returnable: true,
      return_window_days: 15,
      stock_quantity: 200,
      version: 1,
    },
    {
      id: "prod_acc_monitor_arm",
      merchant_id: merchantId,
      variant_id: "acc_monitor_arm",
      title: "Gas-Powered Dual Monitor Arm (17-32 inch)",
      description:
        "Full-motion gas-spring dual monitor arm supporting 17-32 inch displays with clamp + grommet mounting and cable routing.",
      category: "accessories",
      attributes: {
        capacity: "Up to 9 kg per arm",
        vesa: "75x75 / 100x100",
        mounting: "Clamp + Grommet",
        ratingAverage: 4.4,
        ratingCount: 53,
      },
      base_price_minor: 42900, // ₹429.00
      currency: "INR",
      tax_rate_bps: 1800,
      returnable: true,
      return_window_days: 30,
      stock_quantity: 60,
      version: 1,
    },
  ];

  for (const item of sampleProducts) {
    const existing = await db
      .select()
      .from(products)
      .where(eq(products.variant_id, item.variant_id));

    if (existing.length === 0) {
      await db.insert(products).values(item);
      console.log(`✅ Seeded product: ${item.title} (${item.variant_id})`);
    }
  }

  // 3. Registered Agents
  const sampleAgents = [
    {
      id: "agt_apollo_buyer_v1",
      display_name: "Apollo Autonomous Shopper",
      version: "1.0.0",
      status: "active",
      metadata: {
        operator: "Apollo Technologies Inc.",
        supportedModes: ["delegated", "autonomous"],
        securityTier: "certified",
      },
    },
    {
      id: "agt_budget_assistant_v2",
      display_name: "BudgetMate Assistant",
      version: "2.1.0",
      status: "active",
      metadata: {
        operator: "FinBot AI",
        supportedModes: ["delegated"],
        securityTier: "standard",
      },
    },
  ];

  for (const agent of sampleAgents) {
    const existing = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agent.id));

    if (existing.length === 0) {
      await db.insert(agents).values(agent);
      console.log(`✅ Seeded agent: ${agent.display_name} (${agent.id})`);
    }
  }

  console.log("✨ Seeding completed successfully!");
}

// Auto-run if executed directly
if (require.main === module || process.argv[1]?.includes("seed")) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Seeding failed:", err);
      process.exit(1);
    });
}
