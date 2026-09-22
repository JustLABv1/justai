import base64
import io
import json
import unittest
import zipfile
from processor import transform, xml, text, W, S, A, T


def archive(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, value in entries.items():
            z.writestr(name, value)
    return stream.getvalue()


def request(data, extension, **args):
    return transform({'data': base64.b64encode(data).decode(), 'extension': extension, **args})


class Templates(unittest.TestCase):
    def test_word_split_runs_and_original_assets(self):
        source = archive({'word/document.xml': f'<w:document xmlns:w="{W}"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>{{{{na</w:t></w:r><w:r><w:t>me}}}}</w:t></w:r></w:p></w:body></w:document>', 'word/media/logo.png': b'unchanged-logo'})
        result = request(source, 'docx')
        self.assertEqual(result['placeholders'], ['name'])
        output = request(source, 'docx', action='render', values={'name': 'Müller & Co <Berlin>'})
        z = zipfile.ZipFile(io.BytesIO(base64.b64decode(output['data'])))
        self.assertEqual(z.read('word/media/logo.png'), b'unchanged-logo')
        document = xml(z.read('word/document.xml'))
        self.assertEqual(text(document), 'Müller & Co <Berlin>')
        self.assertEqual(len(document.getElementsByTagNameNS(W, 'b')), 1)
        self.assertIn(b'{{na', zipfile.ZipFile(io.BytesIO(source)).read('word/document.xml'))

    def test_spreadsheet_shared_strings_numbers_formulas_new_cells(self):
        sheet = f'<worksheet xmlns="{S}"><dimension ref="A1:C2"/><sheetData><row r="1"><c r="A1" t="s" s="4"><v>0</v></c><c r="B1" t="s"><v>0</v></c></row><row r="2"><c r="C2"><f>SUM(D1:D100)</f><v>0</v></c></row></sheetData></worksheet>'
        source = archive({'xl/worksheets/sheet1.xml': sheet, 'xl/sharedStrings.xml': f'<sst xmlns="{S}"><si><t>{{{{name}}}}</t></si></sst>', 'xl/workbook.xml': f'<workbook xmlns="{S}"/>'})
        output = request(source, 'xlsx', action='render', values={'name': 'Ada'}, edits={'xl/worksheets/sheet1.xml#D4': 42.5, 'xl/worksheets/sheet1.xml#A1': 'Another name', 'xl/worksheets/sheet1.xml#E4': '=HYPERLINK("test")'})
        z = zipfile.ZipFile(io.BytesIO(base64.b64decode(output['data'])))
        doc = xml(z.read('xl/worksheets/sheet1.xml'))
        cells = {c.getAttribute('r'): c for c in doc.getElementsByTagNameNS(S, 'c')}
        self.assertEqual(text(cells['A1']), 'Another name')
        self.assertEqual(cells['A1'].getAttribute('s'), '4')
        self.assertEqual(text(cells['B1']), 'Ada')
        self.assertEqual(text(cells['D4']), '42.5')
        self.assertEqual(cells['D4'].getAttribute('t'), '')
        self.assertEqual(cells['E4'].getAttribute('t'), 'inlineStr')
        self.assertEqual(len(doc.getElementsByTagNameNS(S, 'f')), 1)
        with self.assertRaisesRegex(ValueError, 'formulas'):
            request(source, 'xlsx', action='render', values={'name': 'Ada'}, edits={'xl/worksheets/sheet1.xml#C2': '0'})

    def test_powerpoint_and_opendocument(self):
        for ext, path, content in [
            ('pptx', 'ppt/slides/slide1.xml', f'<a:p xmlns:a="{A}"><a:r><a:t>{{{{name}}}}</a:t></a:r></a:p>'),
            ('odt', 'content.xml', f'<text:p xmlns:text="{T}">{{{{name}}}}</text:p>'),
            ('ods', 'content.xml', f'<text:p xmlns:text="{T}">{{{{name}}}}</text:p>'),
            ('odp', 'content.xml', f'<text:p xmlns:text="{T}">{{{{name}}}}</text:p>'),
        ]:
            with self.subTest(ext=ext):
                result = request(archive({path: content}), ext, action='render', values={'name': 'Test'})
                z = zipfile.ZipFile(io.BytesIO(base64.b64decode(result['data'])))
                self.assertEqual(text(xml(z.read(path))), 'Test')

    def test_repeated_word_rows_preserve_table_style(self):
        source = archive({'word/document.xml': f'<w:document xmlns:w="{W}"><w:body><w:tbl><w:tr><w:tc><w:tcPr><w:shd w:fill="EEEEEE"/></w:tcPr><w:p><w:r><w:t>{{{{item}}}}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>{{{{amount}}}}</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'})
        inspected = request(source, 'docx')
        self.assertEqual(inspected['tableRows'][0]['id'], 'word/document.xml#row0')
        output = request(source, 'docx', action='render', rows={'word/document.xml#row0': [['Train', 42], ['Hotel', 120]]})
        z = zipfile.ZipFile(io.BytesIO(base64.b64decode(output['data'])))
        doc = xml(z.read('word/document.xml'))
        self.assertEqual(len(doc.getElementsByTagNameNS(W, 'tr')), 2)
        self.assertEqual(len(doc.getElementsByTagNameNS(W, 'shd')), 2)
        self.assertEqual(text(doc), 'Train42Hotel120')

    def test_missing_unknown_and_partial_fields_fail(self):
        for kwargs in [{'values': {'wrong': 'x'}}, {'values': {'name': 'x'}}, {'edits': {'unknown': 'x'}}, {'edits': {'document': '{{name}}'}}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                request(b'{{name}} {{date}}', 'txt', action='render', **kwargs)

    def test_xml_entities_utf16_and_archive_limits(self):
        malicious = '<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]><x>&leak;</x>'
        for encoding in ['utf-8', 'utf-16']:
            with self.assertRaisesRegex(ValueError, 'entities'):
                xml(malicious.encode(encoding))
        with self.assertRaisesRegex(ValueError, 'Expanded'):
            request(archive({'word/document.xml': b'a' * (33 * 1024 * 1024)}), 'docx')

    def test_pdf_fields_and_reference_mode(self):
        from pypdf import PdfWriter, PdfReader
        from pypdf.generic import DictionaryObject, NameObject, TextStringObject, ArrayObject, NumberObject
        writer = PdfWriter()
        page = writer.add_blank_page(width=300, height=300)
        field = DictionaryObject({NameObject('/FT'): NameObject('/Tx'), NameObject('/T'): TextStringObject('name'), NameObject('/V'): TextStringObject(''), NameObject('/Type'): NameObject('/Annot'), NameObject('/Subtype'): NameObject('/Widget'), NameObject('/Rect'): ArrayObject([NumberObject(10), NumberObject(10), NumberObject(200), NumberObject(30)]), NameObject('/DA'): TextStringObject('/Helv 12 Tf 0 g')})
        ref = writer._add_object(field)
        page[NameObject('/Annots')] = ArrayObject([ref])
        writer._root_object[NameObject('/AcroForm')] = writer._add_object(DictionaryObject({NameObject('/Fields'): ArrayObject([ref]), NameObject('/DA'): TextStringObject('/Helv 12 Tf 0 g')}))
        source = io.BytesIO(); writer.write(source)
        self.assertEqual(request(source.getvalue(), 'pdf')['mode'], 'editable')
        result = request(source.getvalue(), 'pdf', action='render', edits={'name': 'Ada'})
        reader = PdfReader(io.BytesIO(base64.b64decode(result['data'])))
        self.assertEqual(reader.get_fields()['name']['/V'], 'Ada')
        blank = PdfWriter(); blank.add_blank_page(width=300, height=300)
        source = io.BytesIO(); blank.write(source)
        self.assertEqual(request(source.getvalue(), 'pdf')['mode'], 'reference')
        with self.assertRaisesRegex(ValueError, 'no form fields'):
            request(source.getvalue(), 'pdf', action='render', edits={'page:1': 'Test'})


if __name__ == '__main__':
    unittest.main()
