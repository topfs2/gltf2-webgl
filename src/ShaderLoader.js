const load = name => {
    const vs = require(`./shaders/${name}.vs`);
    const fs = require(`./shaders/${name}.fs`);

    return { vs, fs };
};

module.exports = { load };
