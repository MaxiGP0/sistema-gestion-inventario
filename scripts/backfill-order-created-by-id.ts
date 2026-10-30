import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import dbConnect from '../lib/mongodb';
import { Order } from '../models/Order';
import { User } from '../models/User';

/**
 * Backfill opcional de `Order.createdById` a partir del username histórico.
 *
 * Los pedidos anteriores a la identidad de servidor sólo tienen `createdBy`.
 * Este script busca el usuario actual por username y completa el ObjectId.
 * Sin argumentos procesa todos los usernames pendientes; con un username
 * limita el backfill a ese vendedor. `--dry-run` sólo informa cuántos pedidos
 * se actualizarían.
 *
 * Uso:
 *   npx tsx scripts/backfill-order-created-by-id.ts
 *   npx tsx scripts/backfill-order-created-by-id.ts vendedor1
 *   npx tsx scripts/backfill-order-created-by-id.ts vendedor1 --dry-run
 */

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const usernameArg = args.find((arg) => !arg.startsWith('--'))?.trim();

async function backfill() {
  try {
    console.log('Conectando a MongoDB...');
    await dbConnect();
    console.log('¡Conectado exitosamente!');

    if (usernameArg) {
      const user = await User.findOne({ username: usernameArg }).select('_id username').lean();
      if (!user) {
        console.error(`No existe un usuario con username "${usernameArg}".`);
        process.exit(1);
      }

      await backfillUsername(usernameArg, user._id);
    } else {
      const usernames = (await Order.distinct('createdBy', { createdById: null })).filter(
        (username): username is string => typeof username === 'string' && username.length > 0,
      );

      if (usernames.length === 0) {
        console.log('No hay pedidos históricos sin createdById: nada que hacer.');
        process.exit(0);
      }

      const users = await User.find({ username: { $in: usernames } })
        .select('_id username')
        .lean();
      const userIdByUsername = new Map(users.map((user) => [user.username, user._id]));

      for (const username of usernames) {
        const userId = userIdByUsername.get(username);
        if (!userId) {
          console.warn(`Se omite "${username}": no existe un usuario actual con ese username.`);
          continue;
        }

        await backfillUsername(username, userId);
      }
    }

    console.log(
      dryRun ? 'Simulación completada: no se modificó ningún pedido.' : '¡Backfill completado!',
    );
    process.exit(0);
  } catch (error) {
    console.error('Error durante el backfill:', error);
    process.exit(1);
  }
}

async function backfillUsername(username: string, userId: unknown) {
  const filter = { createdById: null, createdBy: username };
  const pending = await Order.countDocuments(filter);

  if (pending === 0) {
    console.log(`"${username}": no hay pedidos pendientes.`);
    return;
  }

  if (dryRun) {
    console.log(`"${username}": se actualizarían ${pending} pedido(s).`);
    return;
  }

  const result = await Order.updateMany(filter, { $set: { createdById: userId } });
  console.log(`"${username}": ${result.modifiedCount ?? 0} pedido(s) actualizado(s).`);
}

void backfill();
