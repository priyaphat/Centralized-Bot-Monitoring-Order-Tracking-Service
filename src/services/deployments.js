import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { inTransaction } from '../db.js';
import { publish } from '../events.js';

export const uploadDirectory = path.resolve('uploads');
await mkdir(uploadDirectory, { recursive: true });

export async function createDeployment({ file, targetBotIds, actor }) {
  if (!file || path.extname(file.originalname).toLowerCase() !== '.zip') {
    const error = new Error('a .zip package is required');
    error.statusCode = 400;
    error.code = 'zip_required';
    throw error;
  }
  const deployment = await inTransaction(async (client) => {
    let ids = targetBotIds;
    if (!ids.length) {
      const bots = await client.query('SELECT id FROM oxide_bot_agents ORDER BY id');
      ids = bots.rows.map((bot) => bot.id);
    }
    const inserted = await client.query(
      `INSERT INTO deployments(package_name,stored_name,requested_by,status)
       VALUES ($1,$2,$3,'running') RETURNING *`,
      [file.originalname, file.filename, actor]
    );
    for (const botId of ids) {
      await client.query(
        `INSERT INTO deployment_targets(deployment_id,bot_id,status,completed_at)
         VALUES ($1,$2,'success',now())`,
        [inserted.rows[0].id, botId]
      );
    }
    const updated = await client.query(
      "UPDATE deployments SET status='success',completed_at=now() WHERE id=$1 RETURNING *",
      [inserted.rows[0].id]
    );
    await client.query(
      `INSERT INTO audit_logs(actor,action,target_type,target_id,metadata)
       VALUES ($1,'deployment.create','deployment',$2,$3)`,
      [actor, String(inserted.rows[0].id), { bots: ids, packageName: file.originalname }]
    );
    return { ...updated.rows[0], targetBotIds: ids };
  });
  publish('deployments.changed');
  return deployment;
}
