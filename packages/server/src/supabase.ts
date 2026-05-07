import { createClient } from '@supabase/supabase-js';
import type { PaymentRecord } from './types';
import type { PaymentStore } from './types';

export interface SupabaseStoreConfig {
	supabaseUrl: string;
	supabaseServiceRoleKey: string;
	tableName?: string;
}

export function createSupabaseStore(config: SupabaseStoreConfig) {
	const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
		auth: { persistSession: false },
	});

	const table = config.tableName ?? 'coin_moebius_transactions';

	const store: PaymentStore = {
		async upsert(record: PaymentRecord): Promise<void> {
			const { error } = await supabase.from(table).upsert(
				{
					payment_id: record.paymentId,
					status: record.status,
					provider: record.provider,
					amount: record.amount,
					currency: record.currency,
					metadata: record.metadata,
					confirmations: record.confirmations ?? null,
					updated_at: new Date(record.timestamp).toISOString(),
				},
				{
					onConflict: 'payment_id',
					ignoreDuplicates: false,
				}
			);

			if (error) {
				console.error('[coin-moebius/supabase] upsert error:', error);
				throw error;
			}
		},

		async get(paymentId: string): Promise<PaymentRecord | null> {
			const { data, error } = await supabase.from(table).select('*').eq('payment_id', paymentId).single();

			if (error || !data) return null;

			return {
				paymentId: data.payment_id as string,
				status: data.status as PaymentRecord['status'],
				provider: data.provider as string,
				amount: Number(data.amount),
				currency: data.currency as string,
				metadata: (data.metadata ?? {}) as Record<string, unknown>,
				confirmations: (data.confirmations ?? undefined) as number | undefined,
				timestamp: new Date(data.updated_at as string).getTime(),
				raw: data.raw ?? undefined,
				createdAt: new Date(data.created_at as string).getTime(),
				updatedAt: new Date(data.updated_at as string).getTime(),
			};
		},
	};

	return store;
}
