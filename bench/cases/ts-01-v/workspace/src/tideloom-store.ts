/**
 * clerk: read-only desk access to the marina's ledger.
 * manager: may also draft, issue, void and settle bills.
 * platform: Tideloom support staff.
 */
export type Role = "clerk" | "manager" | "platform";
export type BillStatus = "draft" | "issued" | "settled" | "void";

export interface Tenant {
  id: string;
  name: string;
}
export interface Member {
  id: string;
  tenantId: string;
  role: Role;
}
export interface SlipBill {
  id: string;
  tenantId: string;
  vessel: string;
  berth: string;
  totalMinor: number;
  paidMinor: number;
  creditedMinor: number;
  status: BillStatus;
  revision: number;
}
export interface Remittance {
  id: string;
  tenantId: string;
  billId: string;
  amountMinor: number;
  reference: string;
}
export interface TideCredit {
  id: string;
  tenantId: string;
  billId: string;
  amountMinor: number;
  reason: string;
}
export interface BillPage {
  items: SlipBill[];
  nextOffset: number | null;
}

const copy = <T extends object>(value: T | undefined): T | undefined =>
  value === undefined ? undefined : { ...value };

/** Process-local store; callers receive detached records. */
export class TideloomStore {
  private tenants = new Map<string, Tenant>();
  private members = new Map<string, Member>();
  private bills = new Map<string, SlipBill>();
  private remittances = new Map<string, Remittance>();
  private credits = new Map<string, TideCredit>();
  private counters = new Map<string, number>();

  private id(kind: string): string {
    const next = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, next);
    return `${kind}-${next}`;
  }

  /** Provision a marina account from trusted account-management code. */
  addTenant(name: string): Tenant {
    if (!name.trim()) throw new Error("Tenant name required");
    const row = { id: this.id("marina"), name: name.trim() };
    this.tenants.set(row.id, row);
    return { ...row };
  }

  /** Provision membership; this method is not an HTTP operation. */
  addMember(tenantId: string, role: Role): Member {
    if (!this.tenants.has(tenantId)) throw new Error("Unknown marina");
    if (!["clerk", "manager", "platform"].includes(role)) {
      throw new Error("Unknown membership role");
    }
    const row = { id: this.id("member"), tenantId, role };
    this.members.set(row.id, row);
    return { ...row };
  }

  /** Resolve identity data for request authentication. */
  getMember(id: string): Member | undefined {
    return copy(this.members.get(id));
  }

  /** Find a marina for account administration. */
  getTenant(id: string): Tenant | undefined {
    return copy(this.tenants.get(id));
  }

  /** Read a bill for a marina workspace. */
  getBillForTenant(id: string, tenantId: string): SlipBill | undefined {
    const row = this.bills.get(id);
    return row?.tenantId === tenantId ? copy(row) : undefined;
  }

  /** Read a bill for reconciliation and platform tooling. */
  getBill(id: string): SlipBill | undefined {
    return copy(this.bills.get(id));
  }

  /** Page through a workspace in insertion order. */
  listBills(tenantId: string, offset: number, limit: number): BillPage {
    const rows = [...this.bills.values()].filter(
      row => row.tenantId === tenantId,
    );
    const items = rows.slice(offset, offset + limit).map(row => ({ ...row }));
    const nextOffset = offset + limit < rows.length ? offset + limit : null;
    return { items, nextOffset };
  }

  /** Create a draft berth-service bill. */
  createBill(tenantId: string, vessel: string, berth: string, totalMinor: number): SlipBill {
    if (!this.tenants.has(tenantId)) throw new Error("Unknown marina");
    this.money(totalMinor);
    const row: SlipBill = {
      id: this.id("bill"),
      tenantId,
      vessel,
      berth,
      totalMinor,
      paidMinor: 0,
      creditedMinor: 0,
      status: "draft",
      revision: 1,
    };
    this.bills.set(row.id, row);
    return { ...row };
  }

  /** Amend only drafts; identity and accounting fields are immutable. */
  amendBill(id: string, tenantId: string, vessel: string, berth: string, totalMinor: number): SlipBill {
    const row = this.requireBill(id, tenantId);
    if (row.status !== "draft") throw new Error("Draft required");
    this.money(totalMinor);
    Object.assign(row, { vessel, berth, totalMinor });
    row.revision++;
    return { ...row };
  }

  /** Apply an explicit lifecycle transition. */
  transition(id: string, tenantId: string, target: "issued" | "void"): SlipBill {
    const row = this.requireBill(id, tenantId);
    const issuable = target === "issued" && row.status === "draft";
    const voidable = target === "void"
      && (row.status === "draft" || row.status === "issued")
      && row.paidMinor === 0 && row.creditedMinor === 0;
    if (!issuable && !voidable) throw new Error("Invalid bill transition");
    row.status = target;
    row.revision++;
    return { ...row };
  }

  /** Record an externally received remittance, not a card charge. */
  recordRemittance(id: string, tenantId: string, amountMinor: number, reference: string): Remittance {
    const bill = this.requireBill(id, tenantId);
    this.requireBalance(bill, amountMinor);
    const row = { id: this.id("remit"), tenantId, billId: id, amountMinor, reference };
    this.remittances.set(row.id, row);
    bill.paidMinor += amountMinor;
    this.refresh(bill);
    return { ...row };
  }

  /** Record an adjustment against the remaining balance. */
  issueCredit(id: string, tenantId: string, amountMinor: number, reason: string): TideCredit {
    const bill = this.requireBill(id, tenantId);
    this.requireBalance(bill, amountMinor);
    const row = { id: this.id("credit"), tenantId, billId: id, amountMinor, reason };
    this.credits.set(row.id, row);
    bill.creditedMinor += amountMinor;
    this.refresh(bill);
    return { ...row };
  }

  /** Read a remittance in a marina workspace. */
  getRemittanceForTenant(id: string, tenantId: string): Remittance | undefined {
    const row = this.remittances.get(id);
    return row?.tenantId === tenantId ? copy(row) : undefined;
  }

  /** Read a remittance for settlement reconciliation. */
  getRemittance(id: string): Remittance | undefined {
    return copy(this.remittances.get(id));
  }

  /** Read a credit in a marina workspace. */
  getCreditForTenant(id: string, tenantId: string): TideCredit | undefined {
    const row = this.credits.get(id);
    return row?.tenantId === tenantId ? copy(row) : undefined;
  }

  /** Read a credit for background ledger exports. */
  getCredit(id: string): TideCredit | undefined {
    return copy(this.credits.get(id));
  }

  private requireBill(id: string, tenantId: string): SlipBill {
    const row = this.bills.get(id);
    if (!row || row.tenantId !== tenantId) throw new Error("Bill unavailable");
    return row;
  }

  private money(value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000_000) {
      throw new Error("Invalid minor-unit amount");
    }
  }

  private requireBalance(bill: SlipBill, amount: number): void {
    this.money(amount);
    if (bill.status !== "issued") throw new Error("Issued bill required");
    if (amount > bill.totalMinor - bill.paidMinor - bill.creditedMinor) {
      throw new Error("Amount exceeds remaining balance");
    }
  }

  private refresh(bill: SlipBill): void {
    if (bill.paidMinor + bill.creditedMinor === bill.totalMinor) {
      bill.status = "settled";
    }
    bill.revision++;
  }
}
