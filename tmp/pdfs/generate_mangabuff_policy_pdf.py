from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "output" / "pdf" / "mangabuff-ddos-guard-exception-policy-2026-07-29.pdf"


def register_fonts() -> None:
    candidates = {
        "TimesNewRoman": [
            "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
            "/Library/Fonts/Times New Roman.ttf",
        ],
        "TimesNewRomanBold": [
            "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
            "/Library/Fonts/Times New Roman Bold.ttf",
        ],
    }

    for name, paths in candidates.items():
        for font_path in paths:
            path = Path(font_path)
            if path.exists():
                pdfmetrics.registerFont(TTFont(name, str(path)))
                break
        else:
            raise FileNotFoundError(f"Font not found for {name}")


def build_styles():
    styles = getSampleStyleSheet()

    return {
        "company": ParagraphStyle(
            "Company",
            parent=styles["Normal"],
            fontName="TimesNewRomanBold",
            fontSize=12.5,
            leading=15,
            alignment=TA_CENTER,
            spaceAfter=4 * mm,
        ),
        "title": ParagraphStyle(
            "Title",
            parent=styles["Normal"],
            fontName="TimesNewRomanBold",
            fontSize=13.5,
            leading=17,
            alignment=TA_CENTER,
            spaceAfter=1.5 * mm,
        ),
        "subtitle": ParagraphStyle(
            "Subtitle",
            parent=styles["Normal"],
            fontName="TimesNewRomanBold",
            fontSize=11.2,
            leading=14,
            alignment=TA_CENTER,
            spaceAfter=4 * mm,
        ),
        "meta": ParagraphStyle(
            "Meta",
            parent=styles["Normal"],
            fontName="TimesNewRoman",
            fontSize=11,
            leading=13,
            alignment=TA_LEFT,
            spaceAfter=4 * mm,
        ),
        "section": ParagraphStyle(
            "Section",
            parent=styles["Normal"],
            fontName="TimesNewRomanBold",
            fontSize=11.8,
            leading=14,
            alignment=TA_LEFT,
            spaceBefore=1.5 * mm,
            spaceAfter=1.5 * mm,
        ),
        "body": ParagraphStyle(
            "Body",
            parent=styles["Normal"],
            fontName="TimesNewRoman",
            fontSize=10.8,
            leading=14,
            alignment=TA_JUSTIFY,
            firstLineIndent=8 * mm,
            spaceAfter=1.2 * mm,
        ),
        "bullet": ParagraphStyle(
            "Bullet",
            parent=styles["Normal"],
            fontName="TimesNewRoman",
            fontSize=10.8,
            leading=14,
            alignment=TA_JUSTIFY,
            leftIndent=6 * mm,
            bulletIndent=0,
            spaceAfter=0.8 * mm,
        ),
        "approval": ParagraphStyle(
            "Approval",
            parent=styles["Normal"],
            fontName="TimesNewRomanBold",
            fontSize=12,
            leading=16,
            alignment=TA_LEFT,
            spaceAfter=4 * mm,
        ),
        "signature": ParagraphStyle(
            "Signature",
            parent=styles["Normal"],
            fontName="TimesNewRoman",
            fontSize=11.5,
            leading=18,
            alignment=TA_LEFT,
            spaceAfter=1 * mm,
        ),
    }


def p(text: str, style):
    return Paragraph(text, style)


def build_story(styles):
    story = [
        Spacer(1, 8 * mm),
        p('ООО "МангаБафф"', styles["company"]),
        p("ПОЛОЖЕНИЕ", styles["title"]),
        p(
            "о предоставлении контролируемого исключения для автоматизированного доступа через DDoS-Guard",
            styles["subtitle"],
        ),
        p("Дата редакции: 29 июля 2026 года", styles["meta"]),
    ]

    sections = [
        (
            "1. Общие положения",
            [
                "1.1. Настоящее Положение определяет порядок предоставления контролируемого исключения для авторизованного автоматизированного доступа к ресурсам ООО \"МангаБафф\" в случаях, когда такой доступ необходим для обеспечения бизнес-процессов, технического обслуживания, мониторинга, тестирования, интеграций либо иных служебных задач.",
                "1.2. Под контролируемым исключением в рамках настоящего Положения понимается заранее согласованный и документально оформленный порядок пропуска авторизованного автоматизированного трафика через защитный контур DDoS-Guard без изменения общего режима информационной безопасности Общества.",
                "1.3. Настоящее Положение распространяется исключительно на внутренние подразделения ООО \"МангаБафф\", а также на подрядчиков и партнеров, действующих на основании письменного согласования с уполномоченными представителями Общества.",
            ],
            [],
        ),
        (
            "2. Цель предоставления исключения",
            [
                "2.1. Контролируемое исключение предоставляется исключительно для:",
                "2.2. Предоставление исключения не является отказом от мер защиты и не может толковаться как разрешение на неограниченный автоматизированный доступ.",
            ],
            [
                "исполнения служебных задач, связанных с эксплуатацией и поддержкой сервисов;",
                "работы согласованных интеграций и автоматизированных сценариев;",
                "проведения мониторинга, диагностики и тестирования;",
                "иных задач, прямо одобренных ответственным подразделением.",
            ],
        ),
        (
            "3. Условия предоставления исключения",
            [
                "3.1. Контролируемое исключение допускается только при наличии:",
                "3.2. Максимально допустимый объем автоматизированных обращений в рамках предоставленного исключения составляет не более 10 000 (десяти тысяч) запросов за одни календарные сутки.",
                "3.3. Превышение установленного лимита допускается только на основании отдельного письменного решения уполномоченного должностного лица и при наличии дополнительной оценки рисков.",
            ],
            [
                "указания ответственного подразделения или должностного лица;",
                "идентификации используемого сервиса, учетной записи, IP-адреса, токена либо иного средства авторизации;",
                "установленной технической возможности журналирования обращений;",
                "подтвержденной необходимости такого режима доступа.",
            ],
        ),
        (
            "4. Ограничения и запреты",
            [
                "4.1. В рамках настоящего Положения запрещается:",
                "4.2. При выявлении признаков злоупотребления, превышения лимитов, отсутствия журналирования либо возникновения инцидента информационной безопасности предоставленное исключение подлежит немедленному пересмотру, ограничению либо отзыву.",
            ],
            [
                "использовать предоставленное исключение в целях, не связанных с согласованной служебной задачей;",
                "передавать параметры доступа третьим лицам без отдельного согласования;",
                "отключать, ослаблять либо обходить иные меры защиты, не охваченные предоставленным исключением;",
                "использовать доступ способом, который может повлечь деградацию сервиса, нарушение прав третьих лиц, нарушение договора, закона или внутренних регламентов Общества.",
            ],
        ),
        (
            "5. Контроль и отчетность",
            [
                "5.1. Все обращения, осуществляемые в рамках контролируемого исключения, подлежат журналированию в объеме, достаточном для последующей проверки даты, времени, источника, назначения и общего количества запросов.",
                "5.2. Ответственное подразделение обязано на регулярной основе контролировать соблюдение установленного лимита и соответствие фактического использования заявленной цели.",
                "5.3. По запросу руководства, службы информационной безопасности, юридической функции либо иного уполномоченного подразделения сведения о предоставленном исключении и фактическом использовании должны быть представлены в разумный срок.",
            ],
            [],
        ),
        (
            "6. Срок действия и отзыв исключения",
            [
                "6.1. Контролируемое исключение предоставляется на срок, указанный в решении о согласовании, и действует до:",
                "6.2. По окончании срока действия исключение подлежит продлению только после повторного согласования.",
            ],
            [
                "истечения согласованного срока;",
                "достижения цели, для которой оно было предоставлено;",
                "отзыва по решению уполномоченного должностного лица;",
                "выявления нарушений условий настоящего Положения.",
            ],
        ),
        (
            "7. Заключительные положения",
            [
                "7.1. Настоящее Положение вступает в силу с даты его утверждения уполномоченным лицом ООО \"МангаБафф\".",
                "7.2. Все заинтересованные подразделения обязаны руководствоваться настоящим Положением при согласовании и использовании исключений для авторизованного автоматизированного доступа.",
                "7.3. При наличии расхождений между настоящим Положением и локальными инструкциями приоритет имеет настоящий документ до момента утверждения обновленных редакций соответствующих локальных актов.",
            ],
            [],
        ),
    ]

    for heading, paragraphs, bullets in sections:
        story.append(p(heading, styles["section"]))
        bullet_added = False
        for paragraph in paragraphs:
            story.append(p(paragraph, styles["body"]))
            if paragraph.endswith("исключительно для:") or paragraph.endswith("только при наличии:") or paragraph.endswith("запрещается:") or paragraph.endswith("действует до:"):
                for item in bullets:
                    story.append(p(item, styles["bullet"],))
                bullet_added = True
        if bullets and not bullet_added:
            for item in bullets:
                story.append(p(item, styles["bullet"]))

    story.extend(
        [
            Spacer(1, 5 * mm),
            p("УТВЕРЖДАЮ", styles["approval"]),
            Table(
                [
                    ["Подпись: /П.И.О. Иванов/", ""],
                    ["Должность: Генеральный директор", ""],
                    ["Ф.И.О.: Петр Иванов Олегович", ""],
                    ["Дата: 28 июля 2026 года", ""],
                ],
                colWidths=[85 * mm, 80 * mm],
                style=TableStyle(
                    [
                        ("FONTNAME", (0, 0), (-1, -1), "TimesNewRoman"),
                        ("FONTSIZE", (0, 0), (-1, -1), 11.5),
                        ("LEADING", (0, 0), (-1, -1), 18),
                        ("TEXTCOLOR", (0, 0), (-1, -1), colors.black),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                        ("TOPPADDING", (0, 0), (-1, -1), 2),
                    ]
                ),
            ),
        ]
    )

    return story


def add_page_number(canvas, doc):
    canvas.saveState()
    canvas.setFont("TimesNewRoman", 10)
    canvas.drawRightString(190 * mm, 12 * mm, f"Стр. {doc.page}")
    canvas.restoreState()


def main() -> None:
    register_fonts()
    styles = build_styles()

    doc = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=A4,
        leftMargin=22 * mm,
        rightMargin=18 * mm,
        topMargin=14 * mm,
        bottomMargin=16 * mm,
        title="Положение о контролируемом исключении DDoS-Guard",
        author='ООО "МангаБафф"',
    )

    story = build_story(styles)
    doc.build(story, onFirstPage=add_page_number, onLaterPages=add_page_number)


if __name__ == "__main__":
    main()
