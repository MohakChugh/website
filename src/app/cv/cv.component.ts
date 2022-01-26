import { Component, OnInit } from '@angular/core';
import html2pdf from 'html2pdf.js';

@Component({
  selector: 'app-cv',
  templateUrl: './cv.component.html',
  styleUrls: ['./cv.component.css']
})
export class CvComponent implements OnInit {

  showGenerateCvButton = true;
  constructor() { }

  ngOnInit(): void {
  }

  async generateCv() {
    this.showGenerateCvButton = false;
    console.log('Generate CV Function called!');
    const cvContent = document.getElementById('cv-content');
    const options = {
      margin:       1,
      filename:     'mohakchugh_cv.pdf',
      image:        { type: 'jpeg', quality: 1.00 },
      html2canvas:  { scale: 1 },
      jsPDF:        { unit: 'mm', format: 'ledger', orientation: 'portrait' }
    };
    await html2pdf().from(cvContent).set(options).save();
    this.showGenerateCvButton = true;
  }
}
