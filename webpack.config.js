const path = require('path');

const PLUGINS = [];

module.exports = {
  devServer: {
    static: __dirname,
    host: '0.0.0.0'
  },
  entry: './index.js',
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  output: {
    globalObject: 'this',
    path: path.join(__dirname, 'dist'),
    filename: process.env.NODE_ENV === 'production' ? 'osm4vr.min.js' : 'osm4vr.js',
    publicPath: '/dist',
    libraryTarget: 'umd'
  },
  plugins: PLUGINS,
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /(node_modules)/,
        use: ['babel-loader']
      }
    ]
  },
  resolve: {
    extensions: ['.js'],
    modules: [path.join(__dirname, 'node_modules')]
  },
  externals: {
    three: 'THREE'
  }
};
