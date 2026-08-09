/// <reference types="aws-cloudfront-function" />

/**
 * CloudFront Functions Runtime 2.0 (JS)
 * @param {AWSCloudFrontFunction.Event} event CF event
 * @returns {AWSCloudFrontFunction.Request | AWSCloudFrontFunction.Response} The modified request or a response to return to the viewer
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function handler(event) {
	var request = event.request;
	var uri = request.uri;

	// Ensure the URI ends with /index.html
	if (uri.endsWith('/') || !uri.endsWith('index.html')) {
		request.uri = uri + 'index.html';
	}

	return request;
}
