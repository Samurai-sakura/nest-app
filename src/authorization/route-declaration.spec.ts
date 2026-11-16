jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));

import { Controller, Get } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Public } from "./decorators/public.decorator";
import { Receipt } from "./decorators/receipt.decorator";
import { RequirePermission } from "./decorators/require-permission.decorator";
import { readDeclaration } from "./route-declaration";

const API_SECURITY = "swagger/apiSecurity";

@Controller("reports")
class ReportsController {
  @Get("open")
  @Public()
  open() {}

  @Get("list")
  @RequirePermission("reports", "read")
  list() {}

  @Get("remove")
  @RequirePermission("reports", "delete", { audit: true })
  remove() {}

  @Get("status")
  @Receipt("Deletion-Receipt")
  status() {}

  @Get("status-or-permission")
  @Receipt("Deletion-Receipt")
  @RequirePermission("users", "delete")
  statusOrPermission() {}

  @Get("forgotten")
  forgotten() {}

  @Get("public-with-permission")
  @Public()
  @RequirePermission("reports", "read")
  publicWithPermission() {}

  @Get("public-with-receipt")
  @Public()
  @Receipt("Deletion-Receipt")
  publicWithReceipt() {}

  @Get("bad-permission")
  @RequirePermission("Reports", "read")
  badPermission() {}

  @Get("bad-action")
  @RequirePermission("reports", "read all")
  badAction() {}

  @Get("bad-header")
  @Receipt("Deletion Receipt")
  badHeader() {}
}

@Controller("admin")
@RequirePermission("rbac", "manage")
class AdminController {
  @Get("roles")
  roles() {}

  @Get("audit")
  @RequirePermission("audit", "read")
  audit() {}

  @Get("open")
  @Public()
  open() {}
}

@Controller("health")
@Public()
class HealthController {
  @Get()
  live() {}
}

describe("readDeclaration", () => {
  const reflector = new Reflector();
  const read = <T extends object>(controller: new () => T, method: keyof T) =>
    readDeclaration(
      reflector,
      controller.prototype[method] as (...args: never[]) => unknown,
      controller,
    );

  it("reads a public route", () => {
    expect(read(ReportsController, "open")).toEqual({
      valid: true,
      declaration: { kind: "public" },
    });
  });

  it("reads a protected route", () => {
    expect(read(ReportsController, "list")).toEqual({
      valid: true,
      declaration: {
        kind: "protected",
        required: { permission: "reports", action: "read" },
        receiptHeader: undefined,
      },
    });
  });

  it("reads the audit flag of a critical operation", () => {
    expect(read(ReportsController, "remove")).toMatchObject({
      valid: true,
      declaration: { required: { permission: "reports", action: "delete", audit: true } },
    });
  });

  it("reads a receipt route with a lower-cased header", () => {
    expect(read(ReportsController, "status")).toEqual({
      valid: true,
      declaration: { kind: "receipt", receiptHeader: "deletion-receipt" },
    });
  });

  it("reads a receipt combined with a permission", () => {
    expect(read(ReportsController, "statusOrPermission")).toEqual({
      valid: true,
      declaration: {
        kind: "protected",
        required: { permission: "users", action: "delete" },
        receiptHeader: "deletion-receipt",
      },
    });
  });

  it.each([
    ["forgotten", "route has no authorization declaration"],
    ["publicWithPermission", "public route also declares a permission or a receipt"],
    ["publicWithReceipt", "public route also declares a permission or a receipt"],
    ["badPermission", "invalid permission name Reports@read"],
    ["badAction", "invalid permission name reports@read all"],
    ["badHeader", "invalid receipt header deletion receipt"],
  ] as const)("rejects %s", (method, reason) => {
    expect(read(ReportsController, method)).toEqual({ valid: false, reason });
  });

  describe("controller-level declarations", () => {
    it("applies the controller pair to its methods", () => {
      expect(read(AdminController, "roles")).toMatchObject({
        valid: true,
        declaration: { required: { permission: "rbac", action: "manage" } },
      });
    });

    it("lets a method replace the controller pair", () => {
      expect(read(AdminController, "audit")).toMatchObject({
        valid: true,
        declaration: { required: { permission: "audit", action: "read" } },
      });
    });

    it("does not let a method become public under a protected controller", () => {
      expect(read(AdminController, "open")).toEqual({
        valid: false,
        reason: "public route also declares a permission or a receipt",
      });
    });

    it("applies a public controller to its methods", () => {
      expect(read(HealthController, "live")).toEqual({
        valid: true,
        declaration: { kind: "public" },
      });
    });
  });

  it("documents cookie security only for protected routes", () => {
    const security = (method: keyof ReportsController) =>
      Reflect.getMetadata(API_SECURITY, ReportsController.prototype[method]);

    expect(security("list")).toEqual([{ access_token: [] }]);
    expect(security("open")).toBeUndefined();
  });
});
