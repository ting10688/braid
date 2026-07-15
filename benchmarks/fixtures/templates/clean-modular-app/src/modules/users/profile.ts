export interface UserProfile {
  id: string;
  name: string;
}

export const userName = (profile: UserProfile): string => profile.name;
