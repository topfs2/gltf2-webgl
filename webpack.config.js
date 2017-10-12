const path = require('path');

module.exports = {
    entry: './src/main.js',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'bundle.js'
    },
    module: {
        rules: [
            {
                test: /\.js$/,
                exclude: /(node_modules|bower_components)/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: [ 'es2015' ]
                    }
                }
            },
            {
                test   : /\.(png|jpg|svg|mp3|wav|gif|m4a)$/,
                loader : 'file-loader?name=[path][name].[ext]'
            },
            {
                test: /\.(vs|fs)$/,
                use: 'raw-loader'
            },
            {
                test: /\.bin$/,
                use: 'arraybuffer-loader'
            },
            {
                test: /\.(json|gltf)$/,
                loader: 'json-loader'
            }
        ]
    },
    devServer: {
        historyApiFallback: true,
        contentBase: './',
        hot: true
    }
};

