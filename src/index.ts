import { Context } from "@osaas/client-core";
import { getApacheCouchdbInstance, getEyevinnLambdaStitchInstance } from "@osaas/client-services";
import fastify from "fastify";
import nano from "nano";

const FILLER_URL = process.env.FILLER_URL || "https://seivod-secure.akamaized.net/deagad1/playlist.m3u8";
const FILLER_URL_DURATION_SEC = process.env.FILLER_URL_DURATION_SEC ? Number(process.env.FILLER_URL_DURATION_SEC) : 54;

interface IQuerystring {
  channelId: string;
}
interface INextVod {
  id: string;
  title: string;
  hlsUrl: string;
}
interface Asset {
  id: string;
  url: string;
  title?: string;
  breaks: number[];
}
interface Channel extends nano.MaybeDocument {
  channelId: string;
  position: number;
  assets: Asset[];
}

async function getDbUrl(channelDb: string) {
  const ctx = new Context();
  const dbInstance = await getApacheCouchdbInstance(ctx, channelDb);
  const dbUrl = new URL(dbInstance.url);
  dbUrl.username = 'admin';
  dbUrl.password = process.env.DB_PASSWORD || 'cxrwzdZy8M';
  return dbUrl.toString();
}

async function getStitcher(name: string) {
  const ctx = new Context();
  const stitcher = await getEyevinnLambdaStitchInstance(ctx, name)
  return new URL('/stitch/', stitcher.url).toString();
}

async function connect(dbUrl: string) {
  const dbClient = nano(dbUrl);
  const db = dbClient.use('channels');
  return db;
}

async function getAssetsForChannel(db: nano.DocumentScope<unknown>, channelId: string): Promise<Asset[]> {
  const res = await db.find({ selector: { channelId: { "$eq": channelId } } });
  if (res.docs.length > 0) {
    const channel = res.docs[0] as Channel;
    return channel.assets;
  }
  return [];
}

async function getPositionForChannel(db: nano.DocumentScope<unknown>, channelId: string): Promise<number> {
  const res = await db.find({ selector: { channelId: { "$eq": channelId } } });
  if (res.docs.length > 0) {
    const channel = res.docs[0] as Channel;
    return channel.position;
  }
  return -1;
}

async function updatePositionForChannel(db: nano.DocumentScope<unknown>, channelId: string, position: number) {
  const res = await db.find({ selector: { channelId: { "$eq": channelId } } });
  if (res.docs.length > 0) {
    const channel = res.docs[0] as Channel;
    channel.position = position;
    await db.insert(channel);
  }
}

async function getStitchedVod(stitcherUrl: string, asset: Asset): Promise<string> {
  const payload = {
    uri: asset.url,
    breaks: asset.breaks.map((b) => {
      return {
        pos: b * 1000,
        duration: FILLER_URL_DURATION_SEC * 1000,
        url: FILLER_URL
      }
    })
  };
  const res = await fetch(stitcherUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    const stitchedVod = await res.json();
    return new URL(stitchedVod.uri, stitcherUrl).toString();
  } else {
    console.error(`Failed to stitch VOD: ${res.status} ${res.statusText}`);
    const err = await res.json();
    console.error(err.reason);
  }
  return asset.url;
}

async function main() {
  const server = fastify();
  const dbUrl = await getDbUrl(process.env.DB || 'channeldb');
  const stitcherUrl = await getStitcher(process.env.STITCHER || 'teststitch');
  const db = await connect(dbUrl);

  server.get('/', async (request, reply) => {
    reply.send('Hello World');
  });

  server.get<{
    Querystring: IQuerystring;
    Reply: {
      200: INextVod;
      '4xx': { error: string};
    }
  }>('/nextVod', async (request, reply) => {
    const channelId = request.query.channelId;
    if (channelId) {
      console.log(`Requesting next VOD for channel ${channelId}`);
      const assets = await getAssetsForChannel(db, channelId);
      // Currently just choose one at random
      const position = await getPositionForChannel(db, channelId);
      let newPosition;
      if (position === -1) {
        console.log(`Failed to get current position, resetting position for channel ${channelId} to 0`);
        newPosition = 0;
      } else if (position === assets.length - 1) {
        console.log(`End of playlist reached, resetting position for channel ${channelId} to 0`);
        newPosition = 0;
      } else {
        newPosition = position + 1;
      }
      const asset = assets[newPosition];
      const hlsUrl = await getStitchedVod(stitcherUrl, asset);
      await updatePositionForChannel(db, channelId, newPosition);
      reply.code(200).send({
        id: asset.id,
        title: asset.title || 'No title',
        hlsUrl
      });
    } else {
      reply.code(400).send({ error: 'Channel ID not provided' });
    }
  });

  server.listen({ host: '0.0.0.0', port: process.env.PORT ? Number(process.env.PORT) : 8080 }, (err, address) => {
    if (err) console.error(err);
    console.log(`Server listening at ${address}`);
  });
}

main();