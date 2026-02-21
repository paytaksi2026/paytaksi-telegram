import Redis from "ioredis";

export function getRedis(){
  const url = process.env.REDIS_URL;
  if(!url) return null;
  return new Redis(url, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: true,
  });
}
