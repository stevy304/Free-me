/**
 * Reference data only: the video categories creators choose from. No users, channels, videos or money are seeded;
 * all of that comes from real people using the platform. Safe to run more than once.
 */
import { PrismaClient } from '@prisma/client';

const CATEGORIES: Array<[string, string]> = [
  ['Music', 'music'], ['Gaming', 'gaming'], ['News & Politics', 'news'], ['Education', 'education'], ['Sports', 'sports'],
  ['Entertainment', 'entertainment'], ['Comedy', 'comedy'], ['Film & Animation', 'film-animation'], ['Science & Technology', 'science-technology'],
  ['Travel & Events', 'travel-events'], ['Howto & Style', 'howto-style'], ['People & Blogs', 'people-blogs'], ['Pets & Animals', 'pets-animals'],
  ['Autos & Vehicles', 'autos-vehicles'], ['Food & Cooking', 'food-cooking'], ['Health & Fitness', 'health-fitness'],
  ['Business & Finance', 'business-finance'], ['Nonprofits & Activism', 'nonprofits-activism'], ['Faith & Spirituality', 'faith-spirituality'],
  ['Fashion & Beauty', 'fashion-beauty'], ['Podcasts', 'podcasts'],
];

export async function seed(prisma: PrismaClient) {
  for (const [name, slug] of CATEGORIES) await prisma.category.upsert({ where: { slug }, update: { name }, create: { name, slug } });
  return CATEGORIES.length;
}

if (require.main === module || process.argv[1]?.endsWith('seed.ts')) {
  const prisma = new PrismaClient();
  seed(prisma).then((n) => console.log(`Seeded ${n} categories.`)).finally(() => prisma.$disconnect());
}
