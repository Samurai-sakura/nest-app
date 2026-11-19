import type { User, UserStatus } from "../entities/user.entity";
import type { UserProfileResponse } from "../dto/user-profile.dto";

export type UserProfileSource = Pick<
  User,
  "id" | "email" | "displayName" | "photoKey" | "status" | "createdAt" | "updatedAt"
>;

export const STATUSES_WITHOUT_PHOTO: UserStatus[] = ["deleting", "deleted"];

export function toUserProfile(
  user: UserProfileSource,
  publicApiBaseUrl: string,
): UserProfileResponse {
  const hasPhoto = user.photoKey !== null && !STATUSES_WITHOUT_PHOTO.includes(user.status);
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    photoUrl: hasPhoto ? photoUrl(publicApiBaseUrl, user.id) : null,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function photoUrl(publicApiBaseUrl: string, userId: string) {
  return `${publicApiBaseUrl.replace(/\/+$/, "")}/users/${encodeURIComponent(userId)}/photo`;
}
