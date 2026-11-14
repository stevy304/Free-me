/**
 * Who the signed-in person appears as, everywhere (comments, messages, the header, the dock): their Space's name and
 * picture when they have a Space, otherwise their profile's. A Space without its own picture uses the profile picture
 * (the API keeps them in step), so one picture follows the person across the app.
 */
export function me(viewer: { user: { email: string }; profile: { displayName: string; avatarUrl?: string | null } | null; channel: { name: string; avatarUrl?: string | null } | null }) {
  return {
    name: viewer.channel?.name ?? viewer.profile?.displayName ?? viewer.user.email,
    src: viewer.channel?.avatarUrl ?? viewer.profile?.avatarUrl ?? null,
  };
}
