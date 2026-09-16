"use client";

import {
  AlertCircle,
  CheckCircle,
  Edit2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Header } from "@/components/dashboard/Header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatMinorUnits } from "@/lib/utils";

interface Product {
  id: string;
  variant_id: string;
  title: string;
  description?: string;
  category: string;
  base_price_minor: number;
  currency: string;
  stock_quantity: number;
  tax_rate_bps?: number;
  returnable: boolean;
  return_window_days?: number;
  attributes?: Record<string, unknown>;
}

export default function ProductsPage() {
  const [productsList, setProductsList] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  // Form State
  const [formData, setFormData] = useState({
    id: "",
    variant_id: "",
    title: "",
    description: "",
    category: "electronics",
    base_price: 3499,
    stock_quantity: 50,
    tax_rate_bps: 1800,
    returnable: true,
    return_window_days: 7,
    ratingAverage: "4.6",
    ratingCount: "100",
  });

  const fetchProducts = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/merchant/products");
      const data = await res.json();
      if (Array.isArray(data)) {
        setProductsList(data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  const handleOpenAdd = () => {
    setEditingProduct(null);
    setFormData({
      id: "",
      variant_id: "",
      title: "",
      description: "",
      category: "electronics",
      base_price: 1999,
      stock_quantity: 50,
      tax_rate_bps: 1800,
      returnable: true,
      return_window_days: 7,
      ratingAverage: "4.6",
      ratingCount: "100",
    });
    setIsModalOpen(true);
  };

  const handleOpenEdit = (prod: Product) => {
    const attrs = (prod.attributes as Record<string, unknown>) || {};
    setEditingProduct(prod);
    setFormData({
      id: prod.id,
      variant_id: prod.variant_id,
      title: prod.title,
      description: prod.description || "",
      category: prod.category,
      base_price: prod.base_price_minor / 100,
      stock_quantity: prod.stock_quantity,
      tax_rate_bps: prod.tax_rate_bps || 1800,
      returnable: prod.returnable,
      return_window_days: prod.return_window_days || 7,
      ratingAverage: String(attrs.ratingAverage ?? "4.6"),
      ratingCount: String(attrs.ratingCount ?? "100"),
    });
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload = {
        id: formData.id || undefined,
        variant_id: formData.variant_id || undefined,
        title: formData.title,
        description: formData.description,
        category: formData.category,
        base_price_minor: Math.round(Number(formData.base_price) * 100),
        stock_quantity: Number(formData.stock_quantity),
        tax_rate_bps: Number(formData.tax_rate_bps),
        returnable: Boolean(formData.returnable),
        return_window_days: Number(formData.return_window_days),
        attributes: {
          ratingAverage: Math.min(
            5,
            Math.max(0, Number(formData.ratingAverage) || 0),
          ),
          ratingCount: Math.max(0, Number(formData.ratingCount) || 0),
        },
      };

      const res = await fetch("/api/merchant/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        setIsModalOpen(false);
        fetchProducts();
      }
    } catch (e) {
      console.error("Failed to save product:", e);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this product?")) return;
    try {
      const res = await fetch(`/api/merchant/products?id=${id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        fetchProducts();
      }
    } catch (e) {
      console.error("Failed to delete product:", e);
    }
  };

  const filteredProducts = productsList.filter((prod) => {
    const matchesSearch =
      prod.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      prod.variant_id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      prod.category.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory =
      selectedCategory === "all" || prod.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const categories = [
    "all",
    ...Array.from(new Set(productsList.map((p) => p.category))),
  ];

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Products & Catalogue"
        description="Machine-readable SKU definitions, stock quantities, pricing, and return terms for AI buyer agents."
      />

      <div className="p-6 space-y-6">
        {/* Top Actions */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3 w-full sm:w-auto">
            {/* Search Input */}
            <div className="relative flex-1 sm:w-72">
              <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-2.5" />
              <Input
                placeholder="Search SKU, title, category..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 text-xs"
              />
            </div>

            {/* Category Filter */}
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="h-9 px-3 rounded-md border border-input bg-white text-sm text-foreground focus:outline-none focus:border-primary"
            >
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  Category: {cat.toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={fetchProducts}
              className="gap-1.5 text-xs"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh</span>
            </Button>

            <Button
              size="sm"
              onClick={handleOpenAdd}
              className="gap-1.5 text-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Product</span>
            </Button>
          </div>
        </div>

        {/* Products Table Card */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>SKU Inventory Matrix</CardTitle>
            <CardDescription>
              Directly accessible to AI buyer discovery agents
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product & Variant ID</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Base Price (INR)</TableHead>
                  <TableHead>Tax (GST)</TableHead>
                  <TableHead>Rating</TableHead>
                  <TableHead>Stock Status</TableHead>
                  <TableHead>Return Window</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="py-8 text-center text-muted-foreground"
                    >
                      Loading product catalogue...
                    </TableCell>
                  </TableRow>
                ) : filteredProducts.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="py-8 text-center text-muted-foreground"
                    >
                      No products found matching criteria.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredProducts.map((prod) => {
                    const isOutOfStock = prod.stock_quantity <= 0;
                    const isLowStock =
                      prod.stock_quantity > 0 && prod.stock_quantity <= 10;

                    return (
                      <TableRow key={prod.id}>
                        <TableCell>
                          <div className="font-medium text-foreground">
                            {prod.title}
                          </div>
                          <div className="text-[10px] font-mono text-primary">
                            {prod.variant_id}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className="font-mono text-[10px] uppercase"
                          >
                            {prod.category}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono font-semibold text-foreground">
                          {formatMinorUnits(
                            prod.base_price_minor,
                            prod.currency,
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-muted-foreground">
                          {((prod.tax_rate_bps || 1800) / 100).toFixed(0)}%
                        </TableCell>
                        <TableCell>
                          {(() => {
                            const attrs =
                              (prod.attributes as Record<string, unknown>) ||
                              {};
                            const avg = Number(attrs.ratingAverage ?? 0);
                            const count = Number(attrs.ratingCount ?? 0);
                            if (!avg) {
                              return (
                                <span className="text-[11px] text-muted-foreground">
                                  Unrated
                                </span>
                              );
                            }
                            return (
                              <div className="flex items-center gap-1.5">
                                <div
                                  className="flex items-center gap-0.5"
                                  title={`${avg.toFixed(1)} / 5`}
                                >
                                  {[1, 2, 3, 4, 5].map((star) => (
                                    <svg
                                      key={star}
                                      viewBox="0 0 20 20"
                                      className={`w-3 h-3 ${star <= Math.round(avg) ? "fill-[#ffb822] text-[#ffb822]" : "fill-[#e8edf2] text-[#e8edf2]"}`}
                                    >
                                      <title>{`${avg.toFixed(1)} out of 5 stars`}</title>
                                      <path d="M10 1.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L10 14.9l-5.3 2.7 1-5.8L1.5 7.7l5.9-.9L10 1.5z" />
                                    </svg>
                                  ))}
                                </div>
                                <span className="text-[11px] font-mono text-text-secondary">
                                  {avg.toFixed(1)}
                                </span>
                                <span className="text-[10px] text-muted-foreground">
                                  ({count})
                                </span>
                              </div>
                            );
                          })()}
                        </TableCell>
                        <TableCell>
                          {isOutOfStock ? (
                            <Badge variant="destructive" className="gap-1">
                              <XCircle className="w-3 h-3" /> 0 Units
                            </Badge>
                          ) : isLowStock ? (
                            <Badge variant="warning" className="gap-1">
                              <AlertCircle className="w-3 h-3" />{" "}
                              {prod.stock_quantity} left
                            </Badge>
                          ) : (
                            <Badge variant="success" className="gap-1">
                              <CheckCircle className="w-3 h-3" />{" "}
                              {prod.stock_quantity} in stock
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-[11px]">
                          {prod.returnable ? (
                            <span className="text-[#00875c]">
                              {prod.return_window_days}-day returnable
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              Non-returnable
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => handleOpenEdit(prod)}
                              title="Edit"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => handleDelete(prod.id)}
                              className="text-muted-foreground hover:text-destructive"
                              title="Delete"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Add / Edit Dialog Modal */}
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingProduct
                ? "Edit Product SKU"
                : "Add Machine-Readable Product"}
            </DialogTitle>
            <DialogDescription>
              Specify product variant attributes and discovery pricing for AI
              agents.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4 text-xs">
            <div>
              <label
                htmlFor="product-title"
                className="block text-foreground font-medium mb-1"
              >
                Product Title
              </label>
              <Input
                id="product-title"
                required
                value={formData.title}
                onChange={(e) =>
                  setFormData({ ...formData, title: e.target.value })
                }
                placeholder="e.g. Nimbus 75 Mechanical Keyboard"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="variant-id"
                  className="block text-foreground font-medium mb-1"
                >
                  Variant ID (SKU)
                </label>
                <Input
                  id="variant-id"
                  value={formData.variant_id}
                  onChange={(e) =>
                    setFormData({ ...formData, variant_id: e.target.value })
                  }
                  placeholder="e.g. kbd_nimbus_75_black"
                  className="font-mono"
                />
              </div>

              <div>
                <label
                  htmlFor="product-category"
                  className="block text-foreground font-medium mb-1"
                >
                  Category
                </label>
                <select
                  id="product-category"
                  value={formData.category}
                  onChange={(e) =>
                    setFormData({ ...formData, category: e.target.value })
                  }
                  className="h-9 w-full px-3 rounded-md border border-input bg-white text-sm text-foreground focus:outline-none focus:border-primary"
                >
                  <option value="electronics">electronics</option>
                  <option value="audio">audio</option>
                  <option value="accessories">accessories</option>
                  <option value="computers">computers</option>
                  <option value="office">office</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label
                  htmlFor="product-price"
                  className="block text-foreground font-medium mb-1"
                >
                  Price (₹ INR)
                </label>
                <Input
                  id="product-price"
                  type="number"
                  step="0.01"
                  required
                  value={formData.base_price}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      base_price: Number(e.target.value),
                    })
                  }
                  className="font-mono"
                />
              </div>

              <div>
                <label
                  htmlFor="product-stock"
                  className="block text-foreground font-medium mb-1"
                >
                  Stock Qty
                </label>
                <Input
                  id="product-stock"
                  type="number"
                  required
                  value={formData.stock_quantity}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      stock_quantity: Number(e.target.value),
                    })
                  }
                  className="font-mono"
                />
              </div>

              <div>
                <label
                  htmlFor="product-tax"
                  className="block text-foreground font-medium mb-1"
                >
                  Tax BPS
                </label>
                <Input
                  id="product-tax"
                  type="number"
                  value={formData.tax_rate_bps}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      tax_rate_bps: Number(e.target.value),
                    })
                  }
                  placeholder="1800 (18%)"
                  className="font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="product-rating-avg"
                  className="block text-foreground font-medium mb-1"
                >
                  Rating Average (0–5)
                </label>
                <Input
                  id="product-rating-avg"
                  type="number"
                  step="0.1"
                  min={0}
                  max={5}
                  required
                  value={formData.ratingAverage}
                  onChange={(e) =>
                    setFormData({ ...formData, ratingAverage: e.target.value })
                  }
                  placeholder="4.6"
                  className="font-mono"
                />
              </div>

              <div>
                <label
                  htmlFor="product-rating-count"
                  className="block text-foreground font-medium mb-1"
                >
                  Rating Count
                </label>
                <Input
                  id="product-rating-count"
                  type="number"
                  min={0}
                  required
                  value={formData.ratingCount}
                  onChange={(e) =>
                    setFormData({ ...formData, ratingCount: e.target.value })
                  }
                  placeholder="128"
                  className="font-mono"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="product-description"
                className="block text-foreground font-medium mb-1"
              >
                Description
              </label>
              <Textarea
                id="product-description"
                rows={2}
                value={formData.description}
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
                placeholder="Detailed description readable by LLMs & discovery tools..."
              />
            </div>

            <div className="flex items-center gap-6 pt-1">
              <label className="flex items-center gap-2 text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.returnable}
                  onChange={(e) =>
                    setFormData({ ...formData, returnable: e.target.checked })
                  }
                  className="rounded accent-primary focus:ring-[#0066ff]/30"
                />
                <span>Returnable item</span>
              </label>

              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Return window:</span>
                <Input
                  type="number"
                  value={formData.return_window_days}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      return_window_days: Number(e.target.value),
                    })
                  }
                  className="w-16 h-8 font-mono text-center"
                />
                <span className="text-muted-foreground">days</span>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setIsModalOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm">
                {editingProduct ? "Save Changes" : "Create SKU"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
