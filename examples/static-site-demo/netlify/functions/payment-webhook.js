import { verify, registerVerifier, createSupabaseStore } from '@aquarianmetals/coin-moebius-server';
import { createStripeVerifier } from '@aquarianmetals/coin-moebius-stripe/server';
import { createCryptomusVerifier } from '@aquarianmetals/coin-moebius-monero-cryptomus/server';

const store = createSupabaseStore({
	supabaseUrl: process.env.SUPABASE_URL ?? '',
	supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
});

registerVerifier(
	'stripe',
	createStripeVerifier({
		endpointSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
		secretKey: process.env.STRIPE_SECRET_KEY,
	})
);
registerVerifier(
	'monero-cryptomus',
	createCryptomusVerifier({
		merchantUuid: process.env.CRYPTOMUS_MERCHANT_UUID ?? '',
		paymentApiKey: process.env.CRYPTOMUS_PAYMENT_API_KEY ?? '',
	})
);

export default async (req) => {
	let body = req.body;
	if (typeof body === 'string') {
		body = JSON.parse(body);
	}
	const result = await verify(body, req.headers);
	const confirmations = result.metadata.confirmations;
	await store.upsert({
		...result,
		confirmations:
			typeof confirmations === 'number' ? confirmations : Number(confirmations) || undefined,
		createdAt: result.timestamp,
		updatedAt: Date.now(),
	});
	return { statusCode: 200 };
};
