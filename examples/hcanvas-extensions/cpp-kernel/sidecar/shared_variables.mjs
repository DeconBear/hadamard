export const CPP_VARIABLES_MIME = 'application/vnd.hcanvas.variables+json';

export const CPP_SHARED_HEADER = String.raw`#pragma once
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <variant>
#include <vector>

namespace hcanvas {
using Value = std::variant<std::monostate, double, std::string, bool, std::vector<double>>;
inline std::map<std::string, Value>& values() { static auto& store = *new std::map<std::string, Value>(); return store; }
inline void define(const std::string& name, const Value& value) { values()[name] = value; }
inline double get(const std::string& name, double fallback) {
  const auto it = values().find(name);
  if (it == values().end()) return fallback;
  if (const auto* value = std::get_if<double>(&it->second)) return *value;
  if (const auto* value = std::get_if<bool>(&it->second)) return *value ? 1.0 : 0.0;
  return fallback;
}
inline std::string get(const std::string& name, const std::string& fallback) {
  const auto it = values().find(name);
  if (it == values().end()) return fallback;
  if (const auto* value = std::get_if<std::string>(&it->second)) return *value;
  return fallback;
}
inline bool get(const std::string& name, bool fallback) {
  const auto it = values().find(name);
  if (it == values().end()) return fallback;
  if (const auto* value = std::get_if<bool>(&it->second)) return *value;
  if (const auto* value = std::get_if<double>(&it->second)) return *value != 0.0;
  return fallback;
}
inline std::vector<double> get(const std::string& name, const std::vector<double>& fallback) {
  const auto it = values().find(name);
  if (it == values().end()) return fallback;
  if (const auto* value = std::get_if<std::vector<double>>(&it->second)) return *value;
  return fallback;
}
inline std::string escape(const std::string& value) {
  std::ostringstream out;
  for (const unsigned char ch : value) {
    switch (ch) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\b': out << "\\b"; break;
      case '\f': out << "\\f"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (ch < 0x20) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(ch) << std::dec;
        else out << static_cast<char>(ch);
    }
  }
  return out.str();
}
inline std::string json(const Value& value) {
  std::ostringstream out;
  if (std::holds_alternative<std::monostate>(value)) return "null";
  if (const auto* item = std::get_if<double>(&value)) {
    if (!std::isfinite(*item)) return "null";
    out << std::setprecision(15) << *item;
    return out.str();
  }
  if (const auto* item = std::get_if<std::string>(&value)) return "\"" + escape(*item) + "\"";
  if (const auto* item = std::get_if<bool>(&value)) return *item ? "true" : "false";
  const auto& items = std::get<std::vector<double>>(value);
  out << '[';
  for (std::size_t index = 0; index < items.size(); ++index) {
    if (index) out << ',';
    out << (std::isfinite(items[index]) ? std::to_string(items[index]) : "null");
  }
  out << ']';
  return out.str();
}
struct Emitter {
  ~Emitter() {
    if (values().empty()) return;
    std::cout << "\n__HCANVAS_VARIABLES__:{";
    bool first = true;
    for (const auto& [name, value] : values()) {
      if (!first) std::cout << ',';
      first = false;
      std::cout << '"' << escape(name) << "\":" << json(value);
    }
    std::cout << "}\n";
  }
};
inline Emitter emitter;
}

inline double hc_get(const std::string& name, double fallback) { return hcanvas::get(name, fallback); }
inline double hc_get(const std::string& name, int fallback) { return hcanvas::get(name, static_cast<double>(fallback)); }
inline std::string hc_get(const std::string& name, const std::string& fallback) { return hcanvas::get(name, fallback); }
inline std::string hc_get(const std::string& name, const char* fallback) { return hcanvas::get(name, std::string(fallback)); }
inline bool hc_get(const std::string& name, bool fallback) { return hcanvas::get(name, fallback); }
inline std::vector<double> hc_get(const std::string& name, const std::vector<double>& fallback) { return hcanvas::get(name, fallback); }
inline void hc_set(const std::string& name, const std::string& value) { hcanvas::define(name, value); }
inline void hc_set(const std::string& name, const char* value) { hcanvas::define(name, std::string(value)); }
inline void hc_set(const std::string& name, bool value) { hcanvas::define(name, value); }
inline void hc_set(const std::string& name, const std::vector<double>& value) { hcanvas::define(name, value); }
inline void hc_set(const std::string& name, std::initializer_list<double> value) { hcanvas::define(name, std::vector<double>(value)); }
template <typename T, typename std::enable_if<std::is_arithmetic<T>::value && !std::is_same<T, bool>::value, int>::type = 0>
inline void hc_set(const std::string& name, T value) { hcanvas::define(name, static_cast<double>(value)); }
`;

const CPP_KEYWORDS = new Set('auto bool break case catch char class const constexpr continue default delete do double else enum explicit export extern false float for friend goto if inline int long namespace new noexcept nullptr operator private protected public register return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile wchar_t while'.split(' '));

function validName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && !name.startsWith('__') && !CPP_KEYWORDS.has(name);
}

function literal(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return 'static_cast<double>(' + JSON.stringify(value) + ')';
  if (typeof value === 'string') return 'std::string(' + JSON.stringify(value) + ')';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return 'std::monostate{}';
  if (Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isFinite(item))) {
    return 'std::vector<double>{' + value.map(item => JSON.stringify(item)).join(', ') + '}';
  }
  return null;
}

export function cppSharedDefinitions(variables) {
  const initializers = [];
  const declarations = [];
  for (const [name, value] of Object.entries(variables && typeof variables === 'object' ? variables : {})) {
    if (!validName(name) || JSON.stringify(value).length > 256 * 1024) continue;
    const init = literal(value);
    if (init === null) continue;
    initializers.push('    hcanvas::define(' + JSON.stringify(name) + ', ' + init + ');');
    if (typeof value === 'number') declarations.push('double& ' + name + ' = std::get<double>(hcanvas::values().at(' + JSON.stringify(name) + '));');
    else if (typeof value === 'string') declarations.push('std::string& ' + name + ' = std::get<std::string>(hcanvas::values().at(' + JSON.stringify(name) + '));');
    else if (typeof value === 'boolean') declarations.push('bool& ' + name + ' = std::get<bool>(hcanvas::values().at(' + JSON.stringify(name) + '));');
    else if (Array.isArray(value)) declarations.push('std::vector<double>& ' + name + ' = std::get<std::vector<double>>(hcanvas::values().at(' + JSON.stringify(name) + '));');
  }
  return ['namespace { struct HcSharedInitializer { HcSharedInitializer() {', ...initializers, '} }; HcSharedInitializer hc_shared_initializer; }', ...declarations].join('\n');
}

export function splitCppVariableOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/u);
  const visible = [];
  let variables = {};
  for (const line of lines) {
    if (!line.startsWith('__HCANVAS_VARIABLES__:')) { visible.push(line); continue; }
    try {
      const value = JSON.parse(line.slice('__HCANVAS_VARIABLES__:'.length));
      if (value && typeof value === 'object' && !Array.isArray(value)) variables = value;
    } catch { /* Ignore malformed output and keep the process result readable. */ }
  }
  return { variables, stdout: visible.join('\n') };
}
