#extension GL_EXT_shader_texture_lod : enable
precision mediump float;

uniform vec3 camPos;

// IBL
#ifdef HAVE_IBL
uniform samplerCube irradianceSampler;
uniform samplerCube radianceSampler;
uniform sampler2D brdfSampler;
#endif

// material parameters
uniform sampler2D albedoSampler;
uniform sampler2D metallicRoughnessSampler;

#ifdef HAVE_OCCLUSION_TEXTURE
uniform sampler2D occlusionSampler;
#endif

#ifdef HAVE_EMISSIVE_TEXTURE
uniform sampler2D emissiveSampler;
#endif

// lights
uniform vec3 lightPositions[HAVE_LIGHTS];
uniform vec3 lightColors[HAVE_LIGHTS];

varying vec2 TexCoords;
varying vec3 WorldPos;
varying vec3 Normal;

const float PI = 3.14159265359;
// ----------------------------------------------------------------------------
float DistributionGGX(vec3 N, vec3 H, float roughness)
{
    float a = roughness*roughness;
    float a2 = a*a;
    float NdotH = max(dot(N, H), 0.0);
    float NdotH2 = NdotH*NdotH;

    float nom   = a2;
    float denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;

    return nom / denom;
}
// ----------------------------------------------------------------------------
float GeometrySchlickGGX(float NdotV, float roughness)
{
    float r = (roughness + 1.0);
    float k = (r*r) / 8.0;

    float nom   = NdotV;
    float denom = NdotV * (1.0 - k) + k;

    return nom / denom;
}
// ----------------------------------------------------------------------------
float GeometrySmith(vec3 N, vec3 V, vec3 L, float roughness)
{
    float NdotV = max(dot(N, V), 0.0);
    float NdotL = max(dot(N, L), 0.0);
    float ggx2 = GeometrySchlickGGX(NdotV, roughness);
    float ggx1 = GeometrySchlickGGX(NdotL, roughness);

    return ggx1 * ggx2;
}
// ----------------------------------------------------------------------------
vec3 fresnelSchlick(float cosTheta, vec3 F0)
{
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}
// ----------------------------------------------------------------------------
vec3 fresnelSchlickRoughness(float cosTheta, vec3 F0, float roughness)
{
    return F0 + (max(vec3(1.0 - roughness), F0) - F0) * pow(1.0 - cosTheta, 5.0);
}

vec3 sRGB_linear(vec3 rgb)
{
    return pow(rgb, vec3(2.2));
}

vec3 linear_sRGB(vec3 linear)
{
    return pow(linear, vec3(1.0/2.2));
}

void main(void) {
#ifdef HAVE_ALBEDO_SRGB
    vec3 albedo = sRGB_linear(texture2D(albedoSampler, TexCoords).rgb);
#else
    vec3 albedo = texture2D(albedoSampler, TexCoords).rgb;
#endif

    vec4 metallicRoughness = texture2D(metallicRoughnessSampler, TexCoords);
    float metallic = metallicRoughness.b;
    float roughness = metallicRoughness.g;

#ifdef HAVE_OCCLUSION_TEXTURE
    float ao = texture2D(occlusionSampler, TexCoords).r;
#else
    float ao = 1.0;
#endif

#ifdef HAVE_EMISSIVE_TEXTURE
#ifdef HAVE_EMISSIVE_SRGB
    vec3 emission = sRGB_linear(texture2D(emissiveSampler, TexCoords).rgb);
#else
    vec3 emission = sRGB_linear(texture2D(emissiveSampler, TexCoords).rgb);
#endif
#endif

    vec3 N = normalize(Normal);
    vec3 V = normalize(camPos - WorldPos);
    vec3 R = -normalize(reflect(V, N));

    // calculate reflectance at normal incidence; if dia-electric (like plastic) use F0
    // of 0.04 and if it's a metal, use the albedo color as F0 (metallic workflow)
    vec3 F0 = vec3(0.04);
    F0 = mix(F0, albedo, metallic);

    // reflectance equation
    vec3 Lo = vec3(0);

    for (int i = 0; i < HAVE_LIGHTS; i++) {
        // calculate per-light radiance
        vec3 L = normalize(lightPositions[i] - WorldPos);
        vec3 H = normalize(V + L);
        float distance = length(lightPositions[i] - WorldPos);
        float attenuation = 1.0 / (distance * distance);
        vec3 radiance = lightColors[i] * attenuation;

        // Cook-Torrance BRDF
        float NDF = DistributionGGX(N, H, roughness);
        float G   = GeometrySmith(N, V, L, roughness);
        vec3 F    = fresnelSchlick(max(dot(H, V), 0.0), F0);

        vec3 nominator    = NDF * G * F;
        float denominator = 4.0 * max(dot(N, V), 0.0) * max(dot(N, L), 0.0) + 0.001; // 0.001 to prevent divide by zero.
        vec3 specular = nominator / denominator;

        // kS is equal to Fresnel
        vec3 kS = F;
        // for energy conservation, the diffuse and specular light can't
        // be above 1.0 (unless the surface emits light); to preserve this
        // relationship the diffuse component (kD) should equal 1.0 - kS.
        vec3 kD = vec3(1.0) - kS;
        // multiply kD by the inverse metalness such that only non-metals
        // have diffuse lighting, or a linear blend if partly metal (pure metals
        // have no diffuse light).
        kD *= 1.0 - metallic;

        // scale light by NdotL
        float NdotL = max(dot(N, L), 0.0);

        // add to outgoing radiance Lo
        Lo += (kD * albedo / PI + specular) * radiance * NdotL;  // note that we already multiplied the BRDF by the Fresnel (kS) so we won't multiply by kS again
    }

#ifdef HAVE_IBL
    vec3 ambient = vec3(0);
    {
        vec3 F = fresnelSchlickRoughness(max(dot(N, V), 0.0), F0, roughness);

        vec3 kS = F;
        vec3 kD = vec3(1.0) - kS;
        kD *= 1.0 - metallic;

        vec3 irradiance = textureCube(irradianceSampler, N).rgb;
#ifdef HAVE_IBL_SRGB
        irradiance = sRGB_linear(irradiance); // TODO remove when we have linear HDR env map
#endif
        vec3 diffuse    = irradiance * albedo;

#if HAVE_LOD
        const float MAX_REFLECTION_LOD = 9.0;
        vec3 prefilteredColor = textureCubeLodEXT(radianceSampler, R, roughness * MAX_REFLECTION_LOD).rgb;
#else
        vec3 prefilteredColor = textureCube(radianceSampler, R).rgb;
#endif
#ifdef HAVE_IBL_SRGB
        prefilteredColor = sRGB_linear(prefilteredColor); // TODO remove when we have linear HDR env map
#endif
        vec2 envBRDF  = texture2D(brdfSampler, vec2(max(dot(N, V), 0.0), roughness)).rg;
        vec3 specular = prefilteredColor * (F * envBRDF.x + envBRDF.y);

        ambient = (kD * diffuse + specular) * ao;
    }
#else
    // ambient lighting (note that the next IBL tutorial will replace
    // this ambient lighting with environment lighting).
    vec3 ambient = vec3(0.03) * albedo * ao;
#endif

    vec3 color = ambient + Lo;

#ifdef HAVE_EMISSIVE_TEXTURE
    color += emission;
#endif

#ifdef HDR_TONEMAP
    // HDR tonemapping
    color = color / (color + vec3(1.0));
#endif

#ifdef GAMME_CORRECT
    // gamma correct
    color = linear_sRGB(color);
#endif

    gl_FragColor = vec4(color, 1.0);
}
