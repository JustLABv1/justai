"""Bounded document inspection and edits. No execution of template code or formulas.

Office ZIP members are copied verbatim unless edited. Targets are stable within a
stored revision; models receive actual paragraph/cell IDs, never filesystem paths.
"""
import base64
import io
import json
import re
import resource
import sys
import zipfile
from xml.dom import minidom

MAX_BYTES = 8 * 1024 * 1024
MAX_EXPANDED = 32 * 1024 * 1024
MAX_TARGETS = 10000
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
T = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'
O = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0'
TABLE = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0'
PLACEHOLDER = re.compile(r'\{\{\s*([\w.-]+)\s*\}\}')
TEXT_EXT = {'txt', 'md', 'csv', 'html', 'json', 'xml'}
OFFICE_EXT = {'docx', 'dotx', 'xlsx', 'xltx', 'pptx', 'potx', 'odt', 'ott', 'ods', 'ots', 'odp', 'otp'}


def xml(data):
    if b'<!DOCTYPE' in data.replace(b'\x00', b'').upper() or b'<!ENTITY' in data.replace(b'\x00', b'').upper():
        raise ValueError('XML document types and entities are not supported')
    return minidom.parseString(data)


def text(node):
    return ''.join(child.data if child.nodeType in (child.TEXT_NODE, child.CDATA_SECTION_NODE)
                   else text(child) for child in node.childNodes)


def scalar(value):
    if not isinstance(value, (str, int, float, bool)) or value is None:
        raise ValueError('Replacement values must be text, numbers, or booleans')
    return str(value) if not isinstance(value, bool) else ('true' if value else 'false')


def set_text_nodes(nodes, value):
    # Preserve run styling, including placeholders split by Word across runs.
    for index, node in enumerate(nodes):
        for child in list(node.childNodes):
            node.removeChild(child)
        node.appendChild(node.ownerDocument.createTextNode(value if index == 0 else ''))
        node.setAttribute('xml:space', 'preserve')


def replace_run_placeholders(nodes, values):
    # Work backwards so original character offsets remain valid. Text outside
    # each placeholder retains its original run and character formatting.
    texts = [text(n) for n in nodes]
    combined = ''.join(texts)
    offsets = []
    total = 0
    for item in texts:
        offsets.append(total)
        total += len(item)
    for match in reversed(list(PLACEHOLDER.finditer(combined))):
        if match.group(1) not in values:
            continue
        start, end = match.span()
        first = next(i for i, original in enumerate(texts) if offsets[i] + len(original) > start)
        last = next(i for i, original in enumerate(texts) if offsets[i] + len(original) >= end)
        before = text(nodes[first])[:start - offsets[first]]
        after = text(nodes[last])[end - offsets[last]:]
        set_text_nodes([nodes[first]], before + values[match.group(1)] + (after if first == last else ''))
        for index in range(first + 1, last):
            set_text_nodes([nodes[index]], '')
        if first != last:
            set_text_nodes([nodes[last]], after)


def transform(request):
    data = base64.b64decode(request['data'], validate=True)
    if not data or len(data) > MAX_BYTES:
        raise ValueError('Template must be between 1 byte and 8 MB')
    ext = request['extension'].lower()
    render = request.get('action') == 'render'
    values = request.get('values', {})
    edits = request.get('edits', {})
    row_edits = request.get('rows', {})
    if not isinstance(row_edits, dict) or len(row_edits) > 100:
        raise ValueError('Invalid table rows')
    used_rows = set()
    table_rows = []
    if not isinstance(values, dict) or not isinstance(edits, dict) or len(values) + len(edits) > MAX_TARGETS:
        raise ValueError('Invalid or excessive replacements')
    values = {k: scalar(v) for k, v in values.items()}
    edits = {k: scalar(v) for k, v in edits.items()}
    targets, placeholders, used_values, used_edits = [], set(), set(), set()
    changed = 0
    unresolved = set()

    def replace(target_id, old):
        nonlocal changed
        placeholders.update(PLACEHOLDER.findall(old))
        targets.append({'id': target_id, 'text': old})
        if len(targets) > MAX_TARGETS:
            raise ValueError('Template exceeds 10000 editable targets')
        if not render:
            return old
        if target_id in edits:
            used_edits.add(target_id)
            new = edits[target_id]
        else:
            def sub(match):
                key = match.group(1)
                if key in values:
                    used_values.add(key)
                    return values[key]
                return match.group(0)
            new = PLACEHOLDER.sub(sub, old)
        unresolved.update(PLACEHOLDER.findall(new))
        if new != old:
            changed += 1
        return new

    result = data
    mode = 'editable'
    if ext in TEXT_EXT:
        original = data.decode('utf-8-sig')
        result = replace('document', original).encode('utf-8')
        if render and ext == 'json':
            json.loads(result)
        if render and ext in {'xml'}:
            xml(result)
    elif ext == 'pdf':
        from pypdf import PdfReader, PdfWriter
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise ValueError('Encrypted PDFs are not supported')
        fields = reader.get_fields() or {}
        if fields:
            updates = {}
            for name, field in fields.items():
                old = str(field.get('/V', ''))
                new = replace(name, old)
                targets[-1]['fieldType'] = str(field.get('/FT', ''))
                if field.get('/FT') == '/Btn':
                    targets[-1]['options'] = [str(x) for x in field.get('/_States_', [])]
                if name in used_edits:
                    updates[name] = new
            if render:
                writer = PdfWriter()
                writer.append(reader)
                writer.update_page_form_field_values(list(writer.pages), updates, auto_regenerate=False)
                output = io.BytesIO()
                writer.write(output)
                result = output.getvalue()
        else:
            mode = 'reference'
            if len(reader.pages) > 200:
                raise ValueError('PDF exceeds 200 pages')
            for index, page in enumerate(reader.pages):
                replace(f'page:{index + 1}', page.extract_text() or '')
            if render:
                raise ValueError('This PDF has no form fields. Use its content as reference with create_pdf; do not claim the original was filled.')
    elif ext in OFFICE_EXT:
        archive = zipfile.ZipFile(io.BytesIO(data))
        members = archive.infolist()
        if len(members) > 2000 or sum(m.file_size for m in members) > MAX_EXPANDED:
            raise ValueError('Expanded template exceeds limits')
        if len({m.filename for m in members}) != len(members):
            raise ValueError('Duplicate archive entries are not supported')
        if any('vbaproject' in m.filename.lower() or 'activex/' in m.filename.lower() for m in members):
            raise ValueError('Active content is not supported in templates')
        replacements = {}
        shared = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            shared_doc = xml(archive.read('xl/sharedStrings.xml'))
            shared = [text(si) for si in shared_doc.getElementsByTagNameNS(S, 'si')]
        for member in members:
            name = member.filename
            is_sheet = name.startswith('xl/worksheets/sheet') and name.endswith('.xml')
            is_doc = (name.startswith('word/') or name.startswith('ppt/slides/slide')) and name.endswith('.xml')
            is_odf = name == 'content.xml' and ext in {'odt', 'ott', 'ods', 'ots', 'odp', 'otp'}
            if not (is_sheet or is_doc or is_odf):
                continue
            doc = xml(archive.read(member))
            changed_before = changed
            row_namespace = TABLE if is_odf else (W if name.startswith('word/') else A)
            row_tag = 'table-row' if is_odf else 'tr'
            original_rows = list(doc.getElementsByTagNameNS(row_namespace, row_tag)) if not is_sheet else []
            for row_index, row in enumerate(original_rows):
                cells = [n for n in row.childNodes if n.nodeType == n.ELEMENT_NODE and n.localName in {'tc', 'table-cell'}]
                table_rows.append({'id': f'{name}#row{row_index}', 'cells': [text(c) for c in cells]})
            if is_sheet:
                sheet_data = doc.getElementsByTagNameNS(S, 'sheetData')
                existing = {cell.getAttribute('r') for cell in doc.getElementsByTagNameNS(S, 'c')}
                def coordinate(ref):
                    match = re.fullmatch(r'([A-Z]{1,3})([1-9][0-9]{0,5})', ref)
                    if not match:
                        raise ValueError('Invalid spreadsheet cell: ' + ref)
                    col = 0
                    for char in match.group(1):
                        col = col * 26 + ord(char) - 64
                    if col > 16384 or int(match.group(2)) > 100000:
                        raise ValueError('Spreadsheet cell exceeds limits')
                    return int(match.group(2)), col
                if render and sheet_data:
                    for key in edits:
                        if not key.startswith(name + '#'):
                            continue
                        ref = key.split('#', 1)[1]
                        row_number, column = coordinate(ref)
                        if ref in existing:
                            continue
                        rows = list(doc.getElementsByTagNameNS(S, 'row'))
                        row = next((r for r in rows if r.getAttribute('r') == str(row_number)), None)
                        if row is None:
                            row = doc.createElementNS(S, 'row')
                            row.setAttribute('r', str(row_number))
                            after = next((r for r in rows if int(r.getAttribute('r')) > row_number), None)
                            sheet_data[0].insertBefore(row, after)
                        cell = doc.createElementNS(S, 'c')
                        cell.setAttribute('r', ref)
                        after = next((c for c in row.getElementsByTagNameNS(S, 'c') if coordinate(c.getAttribute('r'))[1] > column), None)
                        row.insertBefore(cell, after)
                        # A stale dimension must not hide newly populated cells.
                        for dimension in list(doc.getElementsByTagNameNS(S, 'dimension')):
                            dimension.parentNode.removeChild(dimension)
                for cell in doc.getElementsByTagNameNS(S, 'c'):
                    kind = cell.getAttribute('t')
                    formula = cell.getElementsByTagNameNS(S, 'f')
                    cell_values = cell.getElementsByTagNameNS(S, 'v')
                    old = text(cell_values[0]) if cell_values else ''
                    if kind == 's':
                        old = shared[int(old)]
                    elif kind == 'inlineStr':
                        old = ''.join(text(n) for n in cell.getElementsByTagNameNS(S, 't'))
                    if formula:
                        old = '=' + text(formula[0])
                    target_id = name + '#' + cell.getAttribute('r')
                    new = replace(target_id, old)
                    if formula:
                        targets[-1]['readOnly'] = True
                        if new != old:
                            raise ValueError('Existing formulas cannot be overwritten: ' + target_id)
                    if new != old:
                        for child in list(cell.childNodes):
                            if child.nodeType == child.ELEMENT_NODE and child.localName in {'v', 'is', 'f'}:
                                cell.removeChild(child)
                        # Numeric edits retain numeric cell semantics. Strings beginning
                        # with '=' are literal text, never executable formulas.
                        if re.fullmatch(r'-?(?:0|[1-9]\d*)(?:\.\d+)?', new):
                            cell.removeAttribute('t') if cell.hasAttribute('t') else None
                            node = doc.createElementNS(S, 'v')
                            node.appendChild(doc.createTextNode(new))
                            cell.appendChild(node)
                        else:
                            cell.setAttribute('t', 'inlineStr')
                            inline = doc.createElementNS(S, 'is')
                            node = doc.createElementNS(S, 't')
                            node.setAttribute('xml:space', 'preserve')
                            node.appendChild(doc.createTextNode(new))
                            inline.appendChild(node)
                            cell.appendChild(inline)
            else:
                namespace = T if is_odf else (W if name.startswith('word/') else A)
                paragraphs = list(doc.getElementsByTagNameNS(namespace, 'p'))
                if is_odf:
                    paragraphs += list(doc.getElementsByTagNameNS(T, 'h'))
                for index, paragraph in enumerate(paragraphs):
                    nodes = list(paragraph.getElementsByTagNameNS(namespace, 't')) if not is_odf else []
                    old = ''.join(text(n) for n in nodes) if not is_odf else text(paragraph)
                    new = replace(f'{name}#p{index}', old)
                    if is_odf:
                        cell = paragraph.parentNode
                        if cell.namespaceURI == TABLE and cell.localName == 'table-cell':
                            repeated = cell.getAttributeNS(TABLE, 'number-columns-repeated') not in ('', '1') or cell.parentNode.getAttributeNS(TABLE, 'number-rows-repeated') not in ('', '1')
                            if cell.hasAttributeNS(TABLE, 'formula') or repeated:
                                targets[-1]['readOnly'] = True
                                if new != old:
                                    raise ValueError('Formula or repeated cells cannot be overwritten; use distinct input cells')
                            if new != old:
                                for attr in ['value', 'date-value', 'time-value', 'boolean-value', 'string-value']:
                                    if cell.hasAttributeNS(O, attr):
                                        cell.removeAttributeNS(O, attr)
                                if re.fullmatch(r'-?(?:0|[1-9]\d*)(?:\.\d+)?', new):
                                    cell.setAttributeNS(O, 'office:value-type', 'float')
                                    cell.setAttributeNS(O, 'office:value', new)
                                else:
                                    cell.setAttributeNS(O, 'office:value-type', 'string')
                    if new != old:
                        if is_odf:
                            set_text_nodes([paragraph], new)
                        elif nodes:
                            if f'{name}#p{index}' in edits:
                                set_text_nodes(nodes, new)
                            else:
                                replace_run_placeholders(nodes, values)
                        else:
                            run = doc.createElementNS(namespace, 'w:r' if namespace == W else 'a:r')
                            node = doc.createElementNS(namespace, 'w:t' if namespace == W else 'a:t')
                            node.appendChild(doc.createTextNode(new))
                            run.appendChild(node)
                            paragraph.appendChild(run)
            if render:
                for row_index, row in enumerate(original_rows):
                    row_id = f'{name}#row{row_index}'
                    if row_id not in row_edits:
                        continue
                    supplied = row_edits[row_id]
                    if not isinstance(supplied, list) or not 1 <= len(supplied) <= 500:
                        raise ValueError('Provide 1 to 500 replacement table rows')
                    used_rows.add(row_id)
                    for row_values in supplied:
                        clone = row.cloneNode(True)
                        cells = [n for n in clone.childNodes if n.nodeType == n.ELEMENT_NODE and n.localName in {'tc', 'table-cell'}]
                        if not isinstance(row_values, list) or len(row_values) != len(cells):
                            raise ValueError('Table row column count does not match')
                        for cell, value in zip(cells, row_values):
                            value = scalar(value)
                            if cell.hasAttributeNS(TABLE, 'formula'):
                                raise ValueError('Formula rows cannot be repeated')
                            ps = list(cell.getElementsByTagNameNS(namespace, 'p'))
                            if not ps:
                                raise ValueError('Table cell has no editable paragraph')
                            for index, paragraph in enumerate(ps):
                                if is_odf:
                                    set_text_nodes([paragraph], value if index == 0 else '')
                                else:
                                    ns = list(paragraph.getElementsByTagNameNS(namespace, 't'))
                                    if not ns:
                                        run = doc.createElementNS(namespace, 'w:r' if namespace == W else 'a:r')
                                        node = doc.createElementNS(namespace, 'w:t' if namespace == W else 'a:t')
                                        run.appendChild(node)
                                        paragraph.appendChild(run)
                                        ns = [node]
                                    set_text_nodes(ns, value if index == 0 else '')
                            if is_odf:
                                for attr in ['value', 'date-value', 'time-value', 'boolean-value', 'string-value']:
                                    if cell.hasAttributeNS(O, attr):
                                        cell.removeAttributeNS(O, attr)
                                cell.setAttributeNS(O, 'office:value-type', 'string')
                        row.parentNode.insertBefore(clone, row)
                    row.parentNode.removeChild(row)
                    changed += 1
            if render and changed > changed_before:
                replacements[name] = doc.toxml(encoding='utf-8')
        if not targets:
            raise ValueError('No editable document content was found')
        if render:
            if 'xl/workbook.xml' in archive.namelist():
                workbook = xml(archive.read('xl/workbook.xml'))
                calculations = workbook.getElementsByTagNameNS(S, 'calcPr')
                calc = calculations[0] if calculations else workbook.createElementNS(S, 'calcPr')
                calc.setAttribute('fullCalcOnLoad', '1')
                calc.setAttribute('forceFullCalc', '1')
                if not calculations:
                    workbook.documentElement.appendChild(calc)
                replacements['xl/workbook.xml'] = workbook.toxml(encoding='utf-8')
            output = io.BytesIO()
            with zipfile.ZipFile(output, 'w') as destination:
                for member in members:
                    destination.writestr(member, replacements.get(member.filename, archive.read(member)))
            result = output.getvalue()
    else:
        raise ValueError('Unsupported template format. Convert legacy DOC/XLS/PPT/RTF to DOCX/XLSX/PPTX first.')

    inspection = {'mode': mode, 'targets': targets, 'placeholders': sorted(placeholders), 'tableRows': table_rows}
    if len(json.dumps(inspection)) > 512 * 1024:
        raise ValueError('Template content exceeds the 512 KB inspection limit')
    if render:
        if set(edits) != used_edits or set(values) != used_values or set(row_edits) != used_rows:
            raise ValueError('Unknown or unused replacement fields; read the template again')
        if row_edits:
            inspected_output = transform({'data': base64.b64encode(result).decode(), 'extension': ext, 'action': 'inspect'})
            unresolved = set(inspected_output['placeholders'])
        if unresolved:
            raise ValueError('Missing placeholder values: ' + ', '.join(sorted(unresolved)))
        if not changed:
            raise ValueError('No template content was changed')
        if len(result) > MAX_BYTES:
            raise ValueError('Output exceeds 8 MB')
        return {'data': base64.b64encode(result).decode('ascii'), 'changedTargets': changed}
    return inspection


if __name__ == '__main__':
    try:
        if sys.platform.startswith('linux'):
            for kind, requested in [(resource.RLIMIT_AS, 512 * 1024 * 1024), (resource.RLIMIT_CPU, 20)]:
                _, hard = resource.getrlimit(kind)
                limit = requested if hard == resource.RLIM_INFINITY else min(requested, hard)
                resource.setrlimit(kind, (limit, hard))
        print(json.dumps(transform(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'error': str(exc)[:500]}))
        sys.exit(1)
