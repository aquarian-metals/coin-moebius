const guide = { productId: 'jamstack-guide', amount: 19.99, currency: 'USD' };

export function usdProduct(body, res) {
	if (body?.productId === guide.productId) return guide;
	res.statusCode = 404;
	res.setHeader('Content-Type', 'application/json');
	res.end(JSON.stringify({ error: 'Unknown product' }));
	return null;
}
