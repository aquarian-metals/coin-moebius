import { createSupabaseStore } from '@aquarianmetals/coin-moebius-server';

const store = createSupabaseStore({
	supabaseUrl: process.env.SUPABASE_URL ?? '',
	supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
});

export default async (req) => {
	const url = new URL(req.url ?? 'http://localhost/', 'http://localhost');
	const paymentId = url.searchParams.get('paymentId');
	if (!paymentId) {
		return { statusCode: 400, body: 'missing paymentId' };
	}
	const record = await store.get(paymentId);
	return record
		? { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) }
		: { statusCode: 404 };
};
