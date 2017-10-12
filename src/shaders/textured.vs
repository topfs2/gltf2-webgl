uniform mat4 model;
uniform mat4 view;
uniform mat4 projection;

attribute vec3 POSITION;
attribute vec3 NORMAL;
attribute vec2 TEXCOORD_0;

varying vec3 WorldPos;
varying vec3 Normal;
varying vec2 TexCoords;

void main(void) {
    TexCoords = TEXCOORD_0;
    WorldPos = vec3(model * vec4(POSITION, 1.0));
    Normal = mat3(model) * NORMAL;

    gl_Position = projection * view * vec4(WorldPos, 1.0);
}
