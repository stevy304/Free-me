import type { Channel, Profile, User } from '@prisma/client';

export const publicChannel = (c: Channel) => ({
  id: c.id, handle: c.handle, name: c.name, description: c.description, avatarUrl: c.avatarUrl, bannerUrl: c.bannerUrl,
  country: c.country, defaultLanguage: c.defaultLanguage, isVerified: c.isVerified, followerCount: c.subscriberCount,
  totalViews: c.totalViews.toString(), createdAt: c.createdAt,
});

export const ownProfile = (p: Profile | null) => p && ({
  displayName: p.displayName, avatarUrl: p.avatarUrl, bio: p.bio, country: p.country, city: p.city, preferredLanguage: p.preferredLanguage, timezone: p.timezone,
});

export const ownAccount = (u: User & { profile: Profile | null; channel: Channel | null }) => ({
  user: { id: u.id, email: u.email, roles: u.roles, status: u.status, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt },
  // Administrators can use every Premium feature without a membership.
  premium: { active: (!!u.premiumUntil && u.premiumUntil > new Date()) || u.roles.includes('ADMIN'), until: u.premiumUntil, admin: u.roles.includes('ADMIN') },
  profile: ownProfile(u.profile),
  channel: u.channel ? publicChannel(u.channel) : null,
});
