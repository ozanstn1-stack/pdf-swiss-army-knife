//! Lightweight XML helpers shared by the OOXML and ODF code paths.
//!
//! Parsing is intentionally conservative: bounded size, bounded depth, no
//! DTD/entity expansion beyond the five predefined entities. Namespace
//! prefixes are kept verbatim (`w:p`, `text:p`, ...) because that is exactly
//! what document format code needs.

use crate::error::{OfficeError, OfficeResult};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use std::collections::HashMap;

const MAX_DEPTH: usize = 256;

#[derive(Debug, Clone, Default)]
pub struct XmlNode {
    pub name: String,
    pub attrs: HashMap<String, String>,
    pub children: Vec<XmlNode>,
    pub text: String,
}

impl XmlNode {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.get(name).map(String::as_str)
    }

    /// Attribute lookup that ignores the namespace prefix (`w:val` -> `val`).
    pub fn attr_any_ns(&self, local: &str) -> Option<&str> {
        if let Some(value) = self.attrs.get(local) {
            return Some(value);
        }
        self.attrs
            .iter()
            .find(|(key, _)| !key.starts_with("xmlns") && key.rsplit(':').next() == Some(local))
            .map(|(_, value)| value.as_str())
    }

    pub fn child(&self, name: &str) -> Option<&XmlNode> {
        self.children.iter().find(|child| child.name == name || child.local_name() == name)
    }

    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a XmlNode> + 'a {
        self.children.iter().filter(move |child| child.name == name || child.local_name() == name)
    }

    /// Same as `children_named` but the name does not need to outlive the node.
    pub fn children_of<'a>(&'a self, name: &str) -> Vec<&'a XmlNode> {
        self.children.iter().filter(|child| child.name == name || child.local_name() == name).collect()
    }

    pub fn local_name(&self) -> &str {
        self.name.rsplit(':').next().unwrap_or(&self.name)
    }

    /// Concatenated text of this node and all descendants.
    pub fn deep_text(&self) -> String {
        let mut out = self.text.clone();
        for child in &self.children {
            out.push_str(&child.deep_text());
        }
        out
    }

    /// Concatenated text of direct children only (no recursion). Handy when a
    /// paragraph contains multiple runs: `children_named("r").map(deep_text)`.
    pub fn direct_text(&self) -> String {
        let mut out = self.text.clone();
        for child in &self.children {
            out.push_str(&child.text);
        }
        out
    }

    pub fn walk<'a>(&'a self, out: &mut Vec<&'a XmlNode>) {
        out.push(self);
        for child in &self.children {
            child.walk(out);
        }
    }

    pub fn find_all<'a>(&'a self, name: &str, out: &mut Vec<&'a XmlNode>) {
        if self.name == name || self.local_name() == name {
            out.push(self);
        }
        for child in &self.children {
            child.find_all(name, out);
        }
    }
}

pub fn parse_xml(xml: &str) -> OfficeResult<XmlNode> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    reader.config_mut().expand_empty_elements = false;
    let mut stack: Vec<XmlNode> = vec![XmlNode { name: "#document".into(), ..Default::default() }];
    let mut depth = 0usize;
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => {
                depth += 1;
                if depth > MAX_DEPTH {
                    return Err(OfficeError::corrupt("XML nesting is deeper than the safe limit"));
                }
                stack.push(node_from_start(&start)?);
            }
            Ok(Event::Empty(start)) => {
                depth += 1;
                if depth > MAX_DEPTH {
                    return Err(OfficeError::corrupt("XML nesting is deeper than the safe limit"));
                }
                let node = node_from_start(&start)?;
                stack.last_mut().unwrap().children.push(node);
                depth -= 1;
            }
            Ok(Event::End(_)) => {
                if stack.len() > 1 {
                    let node = stack.pop().unwrap();
                    stack.last_mut().unwrap().children.push(node);
                    depth = depth.saturating_sub(1);
                }
            }
            Ok(Event::Text(text)) => {
                let raw = text.into_inner();
                let value = quick_xml::escape::unescape(&raw).map(|value| value.into_owned()).unwrap_or_else(|_| raw.into_owned());
                stack.last_mut().unwrap().text.push_str(&value);
            }
            Ok(Event::CData(data)) => {
                let value = data.into_inner().into_owned();
                stack.last_mut().unwrap().text.push_str(&value);
            }
            Ok(Event::GeneralRef(reference)) => {
                let name = reference.into_inner();
                let value = match name.as_ref() {
                    "amp" => "&",
                    "lt" => "<",
                    "gt" => ">",
                    "quot" => "\"",
                    "apos" => "'",
                    other => {
                        // Numeric character references (&#NN; / &#xNN;) come through here too.
                        if let Some(rest) = other.strip_prefix('#') {
                            let code = if let Some(hex) = rest.strip_prefix('x').or_else(|| rest.strip_prefix('X')) {
                                u32::from_str_radix(hex, 16).ok()
                            } else {
                                rest.parse::<u32>().ok()
                            };
                            if let Some(ch) = code.and_then(char::from_u32) {
                                stack.last_mut().unwrap().text.push(ch);
                            }
                        }
                        continue;
                    }
                };
                stack.last_mut().unwrap().text.push_str(value);
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => {
                return Err(OfficeError::corrupt(format!("Malformed XML: {error}")));
            }
        }
    }
    while stack.len() > 1 {
        let node = stack.pop().unwrap();
        stack.last_mut().unwrap().children.push(node);
    }
    let mut root = stack.pop().unwrap();
    // Quick single-child unwrap keeps call sites predictable.
    if root.children.len() == 1 {
        root = root.children.remove(0);
    }
    Ok(root)
}

fn node_from_start(start: &BytesStart<'_>) -> OfficeResult<XmlNode> {
    let name = start.name().as_ref().to_string();
    let mut attrs = HashMap::new();
    for attribute in start.attributes() {
        let attribute = attribute.map_err(|error| OfficeError::corrupt(format!("Malformed XML attribute: {error}")))?;
        let key = attribute.key.as_ref().to_string();
        let value = quick_xml::escape::unescape(&attribute.value)
            .map(|value| value.into_owned())
            .unwrap_or_else(|_| attribute.value.to_string());
        attrs.insert(key, value);
    }
    Ok(XmlNode { name, attrs, children: Vec::new(), text: String::new() })
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

pub fn escape_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

pub fn escape_attr(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Compact XML builder used by the format writers.
pub struct XmlWriter {
    out: String,
    stack: Vec<String>,
}

impl Default for XmlWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl XmlWriter {
    pub fn new() -> Self {
        Self { out: String::new(), stack: Vec::new() }
    }

    pub fn declaration(&mut self) -> &mut Self {
        self.out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n");
        self
    }

    pub fn open(&mut self, name: &str, attrs: &[(&str, &str)]) -> &mut Self {
        self.out.push('<');
        self.out.push_str(name);
        for (key, value) in attrs {
            self.out.push(' ');
            self.out.push_str(key);
            self.out.push_str("=\"");
            self.out.push_str(&escape_attr(value));
            self.out.push('"');
        }
        self.out.push('>');
        self.stack.push(name.to_string());
        self
    }

    pub fn open_raw_attrs(&mut self, name: &str, attrs: &[(String, String)]) -> &mut Self {
        self.out.push('<');
        self.out.push_str(name);
        for (key, value) in attrs {
            self.out.push(' ');
            self.out.push_str(key);
            self.out.push_str("=\"");
            self.out.push_str(&escape_attr(value));
            self.out.push('"');
        }
        self.out.push('>');
        self.stack.push(name.to_string());
        self
    }

    pub fn close(&mut self, name: &str) -> &mut Self {
        self.out.push_str("</");
        self.out.push_str(name);
        self.out.push('>');
        self.stack.pop();
        self
    }

    /// Closes the most recently opened element.
    pub fn end(&mut self) -> &mut Self {
        if let Some(name) = self.stack.pop() {
            self.out.push_str("</");
            self.out.push_str(&name);
            self.out.push('>');
        }
        self
    }

    pub fn empty(&mut self, name: &str, attrs: &[(&str, &str)]) -> &mut Self {
        self.out.push('<');
        self.out.push_str(name);
        for (key, value) in attrs {
            self.out.push(' ');
            self.out.push_str(key);
            self.out.push_str("=\"");
            self.out.push_str(&escape_attr(value));
            self.out.push('"');
        }
        self.out.push_str("/>");
        self
    }

    pub fn empty_raw_attrs(&mut self, name: &str, attrs: &[(String, String)]) -> &mut Self {
        self.out.push('<');
        self.out.push_str(name);
        for (key, value) in attrs {
            self.out.push(' ');
            self.out.push_str(key);
            self.out.push_str("=\"");
            self.out.push_str(&escape_attr(value));
            self.out.push('"');
        }
        self.out.push_str("/>");
        self
    }

    pub fn text(&mut self, value: &str) -> &mut Self {
        self.out.push_str(&escape_text(value));
        self
    }

    pub fn raw(&mut self, value: &str) -> &mut Self {
        self.out.push_str(value);
        self
    }

    pub fn finish(self) -> String {
        self.out
    }

    pub fn as_str(&self) -> &str {
        &self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_namespaced_document() {
        let xml = r#"<w:document xmlns:w="x"><w:body><w:p><w:r><w:t xml:space="preserve">Hi &amp; bye</w:t></w:r></w:p></w:body></w:document>"#;
        let doc = parse_xml(xml).unwrap();
        assert_eq!(doc.local_name(), "document");
        let mut nodes = Vec::new();
        doc.find_all("w:t", &mut nodes);
        let texts: Vec<String> = nodes.iter().map(|node| node.deep_text()).collect();
        assert_eq!(texts, vec!["Hi & bye".to_string()]);
    }

    #[test]
    fn writer_escapes() {
        let mut writer = XmlWriter::new();
        writer.open("a", &[("b", "1 < 2")]).text("x & y").close("a");
        assert_eq!(writer.finish(), "<a b=\"1 &lt; 2\">x &amp; y</a>");
    }

    #[test]
    fn rejects_deep_nesting() {
        let mut xml = String::new();
        for _ in 0..300 {
            xml.push_str("<a>");
        }
        for _ in 0..300 {
            xml.push_str("</a>");
        }
        assert!(parse_xml(&xml).is_err());
    }
}
