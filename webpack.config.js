/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable import/no-dynamic-require */

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

const execFile = require('child_process').execFile;
const path = require('path');
const { ESBuildMinifyPlugin } = require('esbuild-loader');
const ForkTsCheckerPlugin = require('fork-ts-checker-webpack-plugin');
const JSON5 = require('json5');
const TerserPlugin = require('terser-webpack-plugin');
const webpack = require('webpack');

async function resolveTSConfig(configFile) {
	const data = await new Promise((resolve, reject) => {
		execFile(
			'yarn',
			['tsc', `-p ${configFile}`, '--showConfig'],
			{ cwd: __dirname, encoding: 'utf8', shell: true },
			function (error, stdout, stderr) {
				if (error != null) {
					reject(error);
				}

				resolve(stdout);
			},
		);
	});

	const index = data.indexOf('\n');
	const json = JSON5.parse(data.substr(index + 1));
	return json;
}

/**
 * @param { 'production' | 'development' | 'none' } mode
 * @param {{ esbuild?: boolean; }} env
 * @param { WebpackConfig['entry'] } entry
 * @returns { Promise<WebpackConfig> }
 */
async function getWebviewConfig(mode, env, entry) {
	const basePath = path.join(__dirname, 'webviews');

	/**
	 * @type WebpackConfig['plugins'] | any
	 */
	const plugins = [
		new ForkTsCheckerPlugin({
			async: false,
			eslint: {
				enabled: true,
				files: path.join(basePath, '**', '*.ts'),
				options: { cache: true, configFile: path.join(__dirname, '.eslintrc.webviews.json') },
			},
			formatter: 'basic',
			typescript: {
				configFile: path.join(__dirname, 'tsconfig.webviews.json'),
			},
		}),
	];

	return {
		name: 'webviews',
		context: basePath,
		entry: entry,
		mode: mode,
		target: 'web',
		devtool: mode !== 'production' ? 'source-map' : undefined,
		output: {
			filename: '[name].js',
			path: path.resolve(__dirname, 'dist'),
			publicPath: path.join(__dirname, 'dist'),
		},
		optimization: {
			minimizer: [
				// @ts-ignore
				env.esbuild
					? new ESBuildMinifyPlugin({
						format: 'cjs',
						minify: true,
						treeShaking: true,
						// Keep the class names
						keepNames: true,
						target: 'es2019',
					})
					: new TerserPlugin({
						extractComments: false,
						parallel: true,
						terserOptions: {
							ecma: 2019,
							keep_classnames: /^AbortSignal$/,
							module: true,
						},
					}),
			],
		},
		module: {
			rules: [
				{
					exclude: /node_modules/,
					include: [basePath, path.join(__dirname, 'src')],
					test: /\.tsx?$/,
					use: env.esbuild
						? {
							loader: 'esbuild-loader',
							options: {
								loader: 'tsx',
								target: 'es2019',
								tsconfigRaw: await resolveTSConfig(path.join(__dirname, 'tsconfig.webviews.json')),
							},
						}
						: {
							loader: 'ts-loader',
							options: {
								configFile: path.join(__dirname, 'tsconfig.webviews.json'),
								experimentalWatchApi: true,
								transpileOnly: true,
							},
						},
				},
				{
					test: /\.css/,
					use: ['style-loader', 'css-loader'],
				},
				{
					test: /\.svg/,
					use: ['svg-inline-loader'],
				},
			],
		},
		resolve: {
			extensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.svg'],
			fallback: {
				crypto: require.resolve("crypto-browserify"),
				path: require.resolve('path-browserify'),
				stream: require.resolve("stream-browserify"),
			},
		},
		plugins: plugins,
	};
}

/**
 * @param { 'node' | 'webworker' } target
 * @param { 'production' | 'development' | 'none' } mode
 * @param {{ esbuild?: boolean; }} env
 * @returns { Promise<WebpackConfig> }
 */
async function getExtensionConfig(target, mode, env) {
	const basePath = path.join(__dirname, 'src');

	/**
	 * @type WebpackConfig['plugins'] | any
	 */
	const plugins = [
		new ForkTsCheckerPlugin({
			async: false,
			eslint: {
				enabled: true,
				files: path.join(basePath, '**', '*.ts'),
				options: {
					cache: true,
					configFile: path.join(
						__dirname,
						target === 'webworker' ? '.eslintrc.browser.json' : '.eslintrc.node.json',
					),
				},
			},
			formatter: 'basic',
			typescript: {
				configFile: path.join(__dirname, target === 'webworker' ? 'tsconfig.browser.json' : 'tsconfig.json'),
			},
		})
	];

	if (target === 'webworker') {
		plugins.push(new webpack.ProvidePlugin({
			process: path.join(
				__dirname,
				'node_modules',
				'process',
				'browser.js')
		}));
	}

	return {
		name: `extension:${target}`,
		entry: {
			extension: './src/extension.ts',
		},
		mode: mode,
		target: target,
		devtool: mode !== 'production' ? 'source-map' : undefined,
		output: {
			path: target === 'webworker' ? path.join(__dirname, 'dist', 'browser') : path.join(__dirname, 'dist'),
			libraryTarget: 'commonjs2',
			filename: '[name].js',
			chunkFilename: 'feature-[name].js',
		},
		optimization: {
			minimizer: [
				// @ts-ignore
				env.esbuild
					? new ESBuildMinifyPlugin({
						format: 'cjs',
						minify: true,
						treeShaking: true,
						// // Keep the class names
						// keepNames: true,
						target: 'es2019',
					})
					: new TerserPlugin({
						extractComments: false,
						parallel: true,
						terserOptions: {
							ecma: 2019,
							// // Keep the class names
							// keep_classnames: true,
							module: true,
						},
					}),
			],
		},
		module: {
			rules: [
				{
					exclude: /node_modules/,
					include: path.join(__dirname, 'src'),
					test: /\.tsx?$/,
					use: env.esbuild
						? {
							loader: 'esbuild-loader',
							options: {
								loader: 'ts',
								target: 'es2019',
								tsconfigRaw: await resolveTSConfig(
									path.join(
										__dirname,
										target === 'webworker' ? 'tsconfig.browser.json' : 'tsconfig.json',
									),
								),
							},
						}
						: {
							loader: 'ts-loader',
							options: {
								configFile: path.join(
									__dirname,
									target === 'webworker' ? 'tsconfig.browser.json' : 'tsconfig.json',
								),
								experimentalWatchApi: true,
								transpileOnly: true,
							},
						},
				},
				// // FIXME: apollo-client uses .mjs, which imposes hard restrictions
				// // on imports available from other callers. They probably didn't know
				// // this. They just used .mjs because it seemed new and hip.
				// //
				// // We should either fix or remove that package, then remove this rule,
				// // which introduces nonstandard behavior for mjs files, which are
				// // terrible. This is all terrible. Everything is terrible.👇🏾
				// {
				// 	test: /\.mjs$/,
				// 	include: /node_modules/,
				// 	type: "javascript/auto",
				// },
				{
					exclude: /node_modules/,
					test: /\.(graphql|gql)$/,
					loader: 'graphql-tag/loader',
				},
				// {
				// 	test: /webview-*\.js/,
				// 	use: 'raw-loader'
				// },
			],
		},
		resolve: {
			alias:
				target === 'webworker'
					? {
						'universal-user-agent': path.join(
							__dirname,
							'node_modules',
							'universal-user-agent',
							'dist-web',
							'index.js',
						),
						'node-fetch': 'cross-fetch',
						'vscode-extension-telemetry': path.resolve(
							__dirname,
							'src',
							'env',
							'browser',
							'vscode-extension-telemetry.js',
						),
						'../env/node/net': path.resolve(__dirname, 'src', 'env', 'browser', 'net'),
						'../env/node/ssh': path.resolve(__dirname, 'src', 'env', 'browser', 'ssh'),
						'./env/node/gitProviders/api': path.resolve(
							__dirname,
							'src',
							'env',
							'browser',
							'gitProviders',
							'api',
						),
					}
					: undefined,
			// : {
			// 	'universal-user-agent': path.join(__dirname, 'node_modules', 'universal-user-agent', 'dist-node', 'index.js'),
			// },
			fallback:
				target === 'webworker'
					? {
						crypto: require.resolve("crypto-browserify"),
						path: require.resolve('path-browserify'),
						stream: require.resolve("stream-browserify"),
						url: false,
					}
					: undefined,
			extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
			symlinks: false,
		},
		externals: {
			vscode: 'commonjs vscode',
			// 'utf-8-validate': 'utf-8-validate',
			// 'bufferutil': 'bufferutil',
			// 'encoding': 'encoding',
			'applicationinsights-native-metrics': 'applicationinsights-native-metrics',
			'@opentelemetry/tracing': '@opentelemetry/tracing',
		},
		plugins: plugins,
		stats: {
			preset: 'errors-warnings',
			assets: true,
			colors: true,
			env: true,
			errorsCount: true,
			warningsCount: true,
			timings: true,
		},
	};
}

module.exports =
	/**
	 * @param {{ esbuild?: boolean; } | undefined } env
	 * @param {{ mode: 'production' | 'development' | 'none' | undefined; }} argv
	 * @returns { Promise<WebpackConfig[]> }
	 */
	async function (env, argv) {
		const mode = argv.mode || 'none';

		env = {
			esbuild: false,
			...env,
		};

		return Promise.all([
			getExtensionConfig('node', mode, env),
			getExtensionConfig('webworker', mode, env),
			getWebviewConfig(mode, env, {
				'webview-pr-description': './editorWebview/index.ts',
				'webview-open-pr-view': './activityBarView/index.ts',
				'webview-create-pr-view': './createPullRequestView/index.ts',
			}),
		]);
	};
