// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

// Кроссплатформенный загрузчик функций OpenGL 3.3 Core через SDL_GL_GetProcAddress
// (не требует внешних GLEW/GLAD на Windows, Linux и macOS).

#include <SDL.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#ifdef _WIN32
#define MIND_GL_APIENTRY __stdcall
#else
#define MIND_GL_APIENTRY
#endif

namespace gl33 {

using GLenum     = unsigned int;
using GLboolean  = unsigned char;
using GLbitfield = unsigned int;
using GLint      = int;
using GLsizei    = int;
using GLuint     = unsigned int;
using GLfloat    = float;
using GLchar     = char;
using GLsizeiptr = ptrdiff_t;

inline constexpr GLenum    GL_FALSE_V              = 0;
inline constexpr GLbitfield GL_COLOR_BUFFER_BIT_V  = 0x00004000u;
inline constexpr GLenum    GL_TRIANGLES_V          = 0x0004u;
inline constexpr GLenum    GL_BLEND_V              = 0x0BE2u;
inline constexpr GLenum    GL_SRC_ALPHA_V          = 0x0302u;
inline constexpr GLenum    GL_ONE_MINUS_SRC_ALPHA_V= 0x0303u;
inline constexpr GLenum    GL_FLOAT_V              = 0x1406u;
inline constexpr GLenum    GL_UNSIGNED_BYTE_V      = 0x1401u;
inline constexpr GLenum    GL_ARRAY_BUFFER_V       = 0x8892u;
inline constexpr GLenum    GL_STREAM_DRAW_V        = 0x88E0u;
inline constexpr GLenum    GL_FRAGMENT_SHADER_V    = 0x8B30u;
inline constexpr GLenum    GL_VERTEX_SHADER_V      = 0x8B31u;
inline constexpr GLenum    GL_COMPILE_STATUS_V     = 0x8B81u;
inline constexpr GLenum    GL_LINK_STATUS_V        = 0x8B82u;

struct Procs {
    void   (MIND_GL_APIENTRY* Viewport)(GLint, GLint, GLsizei, GLsizei) = nullptr;
    void   (MIND_GL_APIENTRY* ClearColor)(GLfloat, GLfloat, GLfloat, GLfloat) = nullptr;
    void   (MIND_GL_APIENTRY* Clear)(GLbitfield) = nullptr;
    void   (MIND_GL_APIENTRY* Enable)(GLenum) = nullptr;
    void   (MIND_GL_APIENTRY* BlendFunc)(GLenum, GLenum) = nullptr;
    void   (MIND_GL_APIENTRY* DrawArrays)(GLenum, GLint, GLsizei) = nullptr;

    GLuint (MIND_GL_APIENTRY* CreateShader)(GLenum) = nullptr;
    void   (MIND_GL_APIENTRY* ShaderSource)(GLuint, GLsizei, const GLchar* const*, const GLint*) = nullptr;
    void   (MIND_GL_APIENTRY* CompileShader)(GLuint) = nullptr;
    void   (MIND_GL_APIENTRY* GetShaderiv)(GLuint, GLenum, GLint*) = nullptr;
    void   (MIND_GL_APIENTRY* GetShaderInfoLog)(GLuint, GLsizei, GLsizei*, GLchar*) = nullptr;
    void   (MIND_GL_APIENTRY* DeleteShader)(GLuint) = nullptr;

    GLuint (MIND_GL_APIENTRY* CreateProgram)() = nullptr;
    void   (MIND_GL_APIENTRY* AttachShader)(GLuint, GLuint) = nullptr;
    void   (MIND_GL_APIENTRY* LinkProgram)(GLuint) = nullptr;
    void   (MIND_GL_APIENTRY* GetProgramiv)(GLuint, GLenum, GLint*) = nullptr;
    void   (MIND_GL_APIENTRY* UseProgram)(GLuint) = nullptr;
    void   (MIND_GL_APIENTRY* DeleteProgram)(GLuint) = nullptr;
    GLint  (MIND_GL_APIENTRY* GetUniformLocation)(GLuint, const GLchar*) = nullptr;
    void   (MIND_GL_APIENTRY* Uniform2f)(GLint, GLfloat, GLfloat) = nullptr;

    void   (MIND_GL_APIENTRY* GenVertexArrays)(GLsizei, GLuint*) = nullptr;
    void   (MIND_GL_APIENTRY* BindVertexArray)(GLuint) = nullptr;
    void   (MIND_GL_APIENTRY* DeleteVertexArrays)(GLsizei, const GLuint*) = nullptr;

    void   (MIND_GL_APIENTRY* GenBuffers)(GLsizei, GLuint*) = nullptr;
    void   (MIND_GL_APIENTRY* BindBuffer)(GLenum, GLuint) = nullptr;
    void   (MIND_GL_APIENTRY* BufferData)(GLenum, GLsizeiptr, const void*, GLenum) = nullptr;
    void   (MIND_GL_APIENTRY* BufferSubData)(GLenum, GLsizeiptr, GLsizeiptr, const void*) = nullptr;
    void   (MIND_GL_APIENTRY* DeleteBuffers)(GLsizei, const GLuint*) = nullptr;

    void   (MIND_GL_APIENTRY* EnableVertexAttribArray)(GLuint) = nullptr;
    void   (MIND_GL_APIENTRY* VertexAttribPointer)(GLuint, GLint, GLenum, GLboolean, GLsizei, const void*) = nullptr;

    bool load() noexcept {
        auto ld = [](auto& fn, const char* name) -> bool {
            void* p = SDL_GL_GetProcAddress(name);
            if (!p) return false;
            static_assert(sizeof(fn) == sizeof(p), "Function pointer size mismatch");
            memcpy(&fn, &p, sizeof(fn));
            return true;
        };
        return ld(Viewport, "glViewport") &&
               ld(ClearColor, "glClearColor") &&
               ld(Clear, "glClear") &&
               ld(Enable, "glEnable") &&
               ld(BlendFunc, "glBlendFunc") &&
               ld(DrawArrays, "glDrawArrays") &&
               ld(CreateShader, "glCreateShader") &&
               ld(ShaderSource, "glShaderSource") &&
               ld(CompileShader, "glCompileShader") &&
               ld(GetShaderiv, "glGetShaderiv") &&
               ld(GetShaderInfoLog, "glGetShaderInfoLog") &&
               ld(DeleteShader, "glDeleteShader") &&
               ld(CreateProgram, "glCreateProgram") &&
               ld(AttachShader, "glAttachShader") &&
               ld(LinkProgram, "glLinkProgram") &&
               ld(GetProgramiv, "glGetProgramiv") &&
               ld(UseProgram, "glUseProgram") &&
               ld(DeleteProgram, "glDeleteProgram") &&
               ld(GetUniformLocation, "glGetUniformLocation") &&
               ld(Uniform2f, "glUniform2f") &&
               ld(GenVertexArrays, "glGenVertexArrays") &&
               ld(BindVertexArray, "glBindVertexArray") &&
               ld(DeleteVertexArrays, "glDeleteVertexArrays") &&
               ld(GenBuffers, "glGenBuffers") &&
               ld(BindBuffer, "glBindBuffer") &&
               ld(BufferData, "glBufferData") &&
               ld(BufferSubData, "glBufferSubData") &&
               ld(DeleteBuffers, "glDeleteBuffers") &&
               ld(EnableVertexAttribArray, "glEnableVertexAttribArray") &&
               ld(VertexAttribPointer, "glVertexAttribPointer");
    }
};

} // namespace gl33
