import { HttpException, Logger } from "@nestjs/common";

jest.mock("../rbac/services/rbac-policy.service", () => ({ RbacPolicyService: class {} }));

import { AccessControlService } from "./access-control.service";

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const http = error as HttpException;
    return { status: http.getStatus(), body: http.getResponse() };
  }
  throw new Error("expected promise to reject");
}

describe("AccessControlService", () => {
  let rbac: { authorize: jest.Mock };
  let service: AccessControlService;
  let warn: jest.SpyInstance;

  beforeAll(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    rbac = { authorize: jest.fn().mockResolvedValue({ allowed: false, version: 4 }) };
    service = new AccessControlService(rbac as any);
    warn.mockClear();
  });

  describe("requirePermission", () => {
    it("passes when the action is granted", async () => {
      rbac.authorize.mockResolvedValue({ allowed: true, version: 4 });

      await expect(service.requirePermission("user-1", "users", "read_any")).resolves.toBeUndefined();
      expect(rbac.authorize).toHaveBeenCalledWith("user-1", "users", "read_any");
    });

    it("returns permission_denied and logs the requirement", async () => {
      expect(await errorOf(service.requirePermission("user-1", "users", "read_any"))).toEqual({
        status: 403,
        body: { statusCode: 403, code: "permission_denied", message: "Permission denied" },
      });
      expect(warn).toHaveBeenCalledWith(
        "Request rejected reason=permission_denied actorUserId=user-1 required=users@read_any policyVersion=4",
      );
    });
  });

  describe("requireOwner", () => {
    const any = { permission: "notes", action: "update_any" };

    it("lets the owner through without asking RBAC", async () => {
      await service.requireOwner("user-1", { id: "note-1", ownerId: "user-1" }, any);

      expect(rbac.authorize).not.toHaveBeenCalled();
    });

    it("lets another user through with the *_any action", async () => {
      rbac.authorize.mockResolvedValue({ allowed: true, version: 4 });

      await service.requireOwner("user-2", { id: "note-1", ownerId: "user-1" }, any);

      expect(rbac.authorize).toHaveBeenCalledWith("user-2", "notes", "update_any");
    });

    it.each([
      ["without the *_any action", any],
      ["when no *_any action is accepted", undefined],
    ])("returns ownership_denied %s", async (_case, accepted) => {
      expect(
        await errorOf(
          service.requireOwner("user-2", { id: "note-1", ownerId: "user-1" }, accepted),
        ),
      ).toEqual({
        status: 403,
        body: {
          statusCode: 403,
          code: "ownership_denied",
          message: "Access to this resource is denied",
        },
      });
      expect(warn).toHaveBeenCalledWith(
        "Request rejected reason=ownership_denied actorUserId=user-2 resourceId=note-1",
      );
    });

    it("treats a resource without an owner as someone else's", async () => {
      expect(
        (await errorOf(service.requireOwner("user-1", { id: "note-1", ownerId: null }))).status,
      ).toBe(403);
    });
  });
});
